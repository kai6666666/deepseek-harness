/**
 * dsh-android-bridge —— 把宿主 App（Kotlin / 无障碍 / Shizuku）的安卓能力
 * 直接暴露成 DSH 的**原生工具**，不再经过 MCP。
 *
 * ## 为什么改成插件而不是 MCP
 *
 * | | MCP 桥 | 本插件 |
 * |---|---|---|
 * | 工具名 | `mcp__android__tap`（带命名空间前缀，模型要多想一层） | `android_tap`（原生命名） |
 * | 启动依赖 | 需要 `@deepseek-ai/dsh-mcp-client` 连接 127.0.0.1:8765 | 无网络依赖，只读文件信箱 |
 * | 失败面 | 连接失败 / 协议版本 / SSE 断流 | 写文件 + 轮询回执 |
 * | 启动耗时 | 多一次 MCP 握手 | 0 |
 *
 * ## 跨进程怎么打通
 *
 * 引擎 node 是 App 进程的子进程，两者共享 app 私有目录（同一 SELinux 域），
 * 所以走**文件信箱**：本插件把 {id, tool, args} 写进 `$DSH_HOME/android-bridge/req.json`，
 * 原生侧 `AndroidToolBridge` 每 200 ms 轮询、执行、把结果写回 `res-<id>.json`。
 *
 * ⚠️ 必须带自增 `id` 并按 id 配对：并发调用时不能把别人的回执读走。
 * ⚠️ `ctx.tools.register` 必须包 try/catch：注册抛异常会让 cordis 判定插件 failed，
 *    引擎直接 `startup failed` 退出（DSH_0.3.4 在这个坑上踩过 54 次）。
 *
 * @module dsh-android-bridge
 */
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-android-bridge';

/** 只要 tools 服务，不碰 shell。 */
export const inject = ['tools'];

const DIR_NAME = 'android-bridge';
const WAIT_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 80;

/** 工具清单：名字 → 参数 schema + 描述 + 一句话标题 */
const TOOLS = [
	{
		name: 'android_screenshot',
		title: '抓取屏幕截图',
		description:
			'Capture the CURRENT screen of this Android device and return where the PNG was written. '
			+ 'Use it when you need to see what is on screen before deciding where to tap. '
			+ 'The file is readable from inside the container, so follow up with a file tool if you need the pixels. '
			+ 'Returns {} on failure with a message explaining whether accessibility / capture permission is missing.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				maxWidth: {
					type: 'number',
					description: 'Downscale so the PNG is at most this many pixels wide (default 1080). Use 540 for a quick glance.',
				},
			},
		},
	},
	{
		name: 'android_ui_dump',
		title: '读取当前界面节点树',
		description:
			'Dump the accessibility node tree of the current window (text, content-desc, resource-id, bounds, clickable). '
			+ 'This is the cheapest way to find what is tappable BEFORE calling android_tap; '
			+ 'coordinates in the dump are absolute screen pixels.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				limit: { type: 'number', description: 'Max nodes to return (default 400).' },
				packageOnly: { type: 'string', description: 'Only keep nodes from this package name.' },
			},
		},
	},
	{
		name: 'android_tap',
		title: '点击屏幕坐标',
		description: 'Tap absolute screen coordinates (pixels). Use android_ui_dump first to get the bounds.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				x: { type: 'number' },
				y: { type: 'number' },
			},
			required: ['x', 'y'],
		},
	},
	{
		name: 'android_swipe',
		title: '滑动屏幕',
		description: 'Swipe from one absolute screen point to another. duration_ms defaults to 300.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				x1: { type: 'number' },
				y1: { type: 'number' },
				x2: { type: 'number' },
				y2: { type: 'number' },
				duration_ms: { type: 'number' },
			},
			required: ['x1', 'y1', 'x2', 'y2'],
		},
	},
	{
		name: 'android_permission',
		title: '查询/申请安卓权限',
		description:
			'Inspect or request one capability of the host app. '
			+ 'kind=accessibility|shizuku|root|battery|overlay. '
			+ 'Without arguments it returns the status of all of them plus the active backend tier.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				kind: {
					type: 'string',
					enum: ['accessibility', 'shizuku', 'root', 'battery', 'overlay'],
					description: 'Omit to only read status.',
				},
			},
		},
	},
	{
		name: 'android_selfcheck',
		title: '宿主自检',
		description:
			'One-shot health report of the host app: accessibility / overlay / battery / shizuku / root / '
			+ 'rootfs / dsh / dsh_runtime / mcp(回环端口) / backend. Use it when a tool fails and you need to know why.',
		parameters: { type: 'object', additionalProperties: false, properties: {} },
	},
];

/** 极简 sleep */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 JSON，坏文件当作不存在 */
function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

/** 原子写：先写 tmp 再 rename，避免宿主读到半截 JSON */
function writeJsonAtomic(file, value) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value));
	fs.renameSync(tmp, file);
}

/**
 * 发一条命令并等回执。
 * @param {string} dir - `$DSH_HOME/android-bridge`
 * @param {number} id - 自增序号
 * @param {string} tool - 工具名（不带 android_ 前缀也给宿主完整名）
 * @param {object} args - 参数
 * @returns {Promise<{ok:boolean,text:string}>}
 */
async function invoke(dir, id, tool, args) {
	const reqFile = path.join(dir, 'req.json');
	const resFile = path.join(dir, `res-${id}.json`);
	try {
		// 上一轮回执若同名残留（进程重启后 id 归零），先清掉，否则会瞬间读到旧结果
		if (fs.existsSync(resFile)) fs.unlinkSync(resFile);
		writeJsonAtomic(reqFile, { id, tool, args: args ?? {}, ts: Date.now() });
	} catch (error) {
		return { ok: false, text: `写入文件信箱失败: ${error?.message ?? error}` };
	}

	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		const reply = readJson(resFile);
		if (!reply || reply.id !== id) continue;
		try {
			fs.unlinkSync(resFile);
		} catch {
			/* 宿主可能已经清理过 */
		}
		const ok = reply.ok === true;
		return {
			ok,
			text: typeof reply.text === 'string' ? reply.text : ok ? 'ok' : '宿主未返回说明',
		};
	}
	return {
		ok: false,
		text: `等待宿主回执超时（${WAIT_TIMEOUT_MS} ms）。宿主可能被系统冻结，或前台服务未运行；`
			+ '请调用 android_selfcheck 查明原因后再重试。',
	};
}

/**
 * 把一条工具声明补成 DSH 需要的完整定义。
 * @param {object} spec - TOOLS 里的一项
 * @param {string} dir - 信箱目录
 * @param {() => number} nextId - 取下一个请求号
 */
function buildTool(spec, dir, nextId) {
	return {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean' },
					text: { type: 'string' },
				},
				required: ['ok', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
		},
		presentCall: (args) => ({
			card: 'generic',
			title: spec.title,
			description: spec.name === 'android_tap' || spec.name === 'android_swipe'
				? `${spec.title} ${JSON.stringify(args ?? {})}`
				: spec.title,
		}),
		async execute(args) {
			const r = await invoke(dir, nextId(), spec.name, args ?? {});
			return { ok: r.ok, text: r.text };
		},
	};
}

/**
 * 注册全部安卓工具。前置条件不满足时**不注册**（注册一个必然失败的工具比不注册更糟）。
 * @param {object} ctx - Cordis 上下文（需 tools 服务）
 */
export function apply(ctx) {
	const home = process.env.DSH_HOME;
	if (typeof home !== 'string' || home === '') {
		ctx?.logger?.warn?.('[dsh-android-bridge] 未配置 DSH_HOME，安卓工具未注册');
		return;
	}
	const dir = path.join(home, DIR_NAME);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (error) {
		ctx?.logger?.warn?.(`[dsh-android-bridge] 无法创建信箱目录 ${dir}: ${error?.message ?? error}`);
		return;
	}
	let seq = 0;
	const nextId = () => ++seq;
	for (const spec of TOOLS) {
		try {
			ctx.tools.register(buildTool(spec, dir, nextId));
		} catch (error) {
			// 单个工具失败不拖垮插件，更不拖垮引擎
			ctx?.logger?.warn?.(`[dsh-android-bridge] 注册 ${spec.name} 失败: ${error?.message ?? error}`);
		}
	}
	ctx?.logger?.info?.(`[dsh-android-bridge] 已注册 ${TOOLS.length} 个安卓工具，信箱 ${dir}`);
}
