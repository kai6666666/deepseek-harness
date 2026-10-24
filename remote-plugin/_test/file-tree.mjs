/**
 * 桌面端「文件树」四个 RPC 的集成测试（`fileList` / `fileRead` / `fileStat` / `fileReadBytes`）。
 *
 * ## 这个测试要证明什么
 *
 * 侧边栏那条链是「手机前端 → 官方 `workspaceFiles` → 本插件的拦截 → 中继 RPC →
 * 电脑的官方 `workspaceFiles`」。链路上最容易悄悄错的是**中段**那截：
 *
 * ① 方法名有没有落到 `handleRpc` 的 switch 上（写错了就是 `unknown method`，
 *    而前端只会画一个「加载失败」，看不出是插件的问题）；
 * ② `sessionId → workspaceRoot` 有没有按官方 `dsh-api-workspace-files` 那个 lookup
 *    的取法拿到（活会话读 `sessions.get().header`，归档会话退回 `sessionPersistence`）；
 * ③ **根目录那次调用**（手机传空串）有没有正确换成 `workspaceRoot` ——
 *    官方 `inspect()` 会拿 `path.length === 0` 直接判 `path is required`，
 *    漏了这一步症状是「侧边栏根目录永远空着」；
 * ④ `fileReadBytes` 的 base64 往返有没有把字节搞坏（官方预览面板认 `Uint8Array`，
 *    拿到字符串会静默不显示）。
 *
 * ⚠️ 这里喂的是**真的临时目录 + 真的 node:fs**，不是 mock 的返回值 ——
 * mock 只能证明「我把参数传下去了」，证明不了「路径解析对了」。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { handleRpc } from '../dsh-remote-desktop/lib/index.js';

let passed = 0;
let failed = 0;
const check = (label, ok, extra = '') => {
	if (ok) {
		passed += 1;
		console.log(`  ✓ ${label}`);
	} else {
		failed += 1;
		console.log(`  ✗ ${label}${extra === '' ? '' : ` —— ${extra}`}`);
	}
};

// ---- 造一棵真的目录树 ----
const root = mkdtempSync(join(tmpdir(), 'dsh-filetree-'));
mkdirSync(join(root, 'src'));
mkdirSync(join(root, '.git'));
writeFileSync(join(root, 'README.md'), '# hello\nsecond line\nthird line\n');
writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x10]);
writeFileSync(join(root, 'logo.png'), png);
console.log('临时工作区:', root);

const SESSION = 'session-file-tree-test';

/**
 * 一个**最小的**官方 `workspaceFiles` 等价实现。
 *
 * 只实现本插件会调到的四个方法，语义照官方（相对路径按 `cwd: workspaceRoot` 解析）。
 * 这样测的才是「本插件怎么用它」，而不是「官方实现对不对」（那是官方的事）。
 */
const workspaceFiles = {
	/**
	 * ⚠️⚠️ **这里【故意】不实现 confine() —— 与真官方行为保持一致。**
	 *
	 * 以前这里照抄了一条 `relative(root, abs).startsWith('..')` 的越界判据，
	 * 于是 ⑥ 节「`..` 被拒」测出来的是**这个 mock 会拒**，而真官方
	 * `workspaceFiles` **根本不拒** —— 公网实测能读到 `C:\Windows\win.ini`
	 * 和 `pair.json`（详见 ⑥ 节的长注释）。
	 *
	 * 那种 mock 给的是**假的安全感**：围栏真被删掉时它照样绿。
	 * 现在让它与真官方一样**不拦**，围栏就成了被测对象。
	 */
	async list(scope, path) {
		const abs = path === scope.workspaceRoot ? path : join(scope.workspaceRoot, path);
		const names = readdirSync(abs);
		const entries = names.map((name) => {
			const st = lstatSync(join(abs, name));
			const type = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
			return { name, type, ...(type === 'file' ? { size: st.size } : {}) };
		});
		return { path: relative(scope.workspaceRoot, abs) || '', entries, truncated: false };
	},
	async read(scope, path, range) {
		const abs = join(scope.workspaceRoot, path);
		const text = readFileSync(abs, 'utf8');
		const lines = text.split('\n');
		const offset = range.offset ?? 1;
		return {
			absolutePath: abs,
			version: String(statSync(abs).mtimeMs),
			bytes: statSync(abs).size,
			offset,
			text: lines.slice(offset - 1, offset - 1 + 5000).join('\n'),
			lines: lines.length,
			eof: true,
		};
	},
	async stat(scope, path) {
		const abs = join(scope.workspaceRoot, path);
		const st = statSync(abs);
		return { absolutePath: abs, version: String(st.mtimeMs), bytes: st.size };
	},
	async readBytes(scope, path, options) {
		const abs = join(scope.workspaceRoot, path);
		const whole = readFileSync(abs);
		const range = options.range;
		const data = range === undefined ? whole : whole.subarray(range.offset ?? 0, (range.offset ?? 0) + (range.length ?? whole.length));
		return { absolutePath: abs, version: String(statSync(abs).mtimeMs), offset: range?.offset ?? 0, data, eof: true };
	},
};

/** 官方 `dsh-api-workspace-files` 那个 lookup 的取法：活会话优先，退回持久化。 */
const ctx = {
	sessionController: {},
	logger: { info() {}, warn() {} },
	sessions: { get: (id) => (id === SESSION ? { header: { cwd: root } } : undefined) },
	get: (name) => (name === 'workspaceFiles' ? workspaceFiles : undefined),
};

const run = (method, params) => handleRpc(ctx, method, params);

// ---- ① fileList：根目录（手机传空串）----
console.log('\n① fileList 根目录');
const rootList = await run('fileList', { sessionId: SESSION, path: '' });
const names = rootList.entries.map((e) => e.name);
check('列到了 README.md', names.includes('README.md'));
check('列到了 src/', names.includes('src'));
check('列到了隐藏的 .git', names.includes('.git'), '隐藏项由前端过滤，电脑端不该自己吞掉');
check('README.md 是 file 且带 size', rootList.entries.find((e) => e.name === 'README.md')?.type === 'file');
check('src 是 directory', rootList.entries.find((e) => e.name === 'src')?.type === 'directory');
check('truncated 字段存在', typeof rootList.truncated === 'boolean');

// ---- ② fileList：子目录（相对路径）----
console.log('\n② fileList 子目录');
const subList = await run('fileList', { sessionId: SESSION, path: 'src' });
check('src 下列到 a.js', subList.entries.map((e) => e.name).join(',') === 'a.js', JSON.stringify(subList.entries));

// ---- ③ fileRead：分页 ----
console.log('\n③ fileRead');
const page = await run('fileRead', { sessionId: SESSION, path: 'README.md' });
check('读到第一行', page.text.startsWith('# hello'), JSON.stringify(page.text));
check('带 version', typeof page.version === 'string' && page.version !== '');
check('带 bytes', typeof page.bytes === 'number');
const page3 = await run('fileRead', { sessionId: SESSION, path: 'README.md', offset: 3 });
check('offset=3 读到第三行', page3.text.trim() === 'third line', JSON.stringify(page3.text));

// ---- ④ fileStat ----
console.log('\n④ fileStat');
const st = await run('fileStat', { sessionId: SESSION, path: 'src/a.js' });
check('stat 有 version', typeof st.version === 'string' && st.version !== '');
check('stat 的 bytes = 20', st.bytes === 20, String(st.bytes));

// ---- ⑤ fileReadBytes：base64 往返 ----
console.log('\n⑤ fileReadBytes');
const bytes = await run('fileReadBytes', { sessionId: SESSION, path: 'logo.png' });
check('data 是 base64 字符串（能进 JSON）', typeof bytes.data === 'string');
const back = Buffer.from(bytes.data, 'base64');
check('字节逐位一致', back.equals(png), `${back.length} vs ${png.length}`);
check('带 version', typeof bytes.version === 'string' && bytes.version !== '');

// ---- ⑥ 越界路径必须被拒 ----
//
// ⚠️ **这一节过去是「假通过」的**：mock 的 `list()` 自己照抄了官方那条
// `relative(root, abs).startsWith('..')` 判据，于是测出来的是「mock 会拒」，
// 而**真官方 `workspaceFiles` 并不拒** —— 公网实测（1.0.14，真令牌）：
//
//   fileStat      { path: 'C:\\Windows\\win.ini' }  → ok=true，92 字节
//   fileReadBytes { path: '..\\..\\..\\..\\..\\..\\Windows\\win.ini' }
//                 → ok=true，data 解出真实内容
//   fileStat      { path: '..\\..\\..\\..\\..\\..\\Users\\你的用户名\\.dsh\\dsh-remote\\pair.json' }
//                 → ok=true，504 字节 —— **连访问令牌都能被读走**
//
// 所以现在把 mock 里那条 confine() **删掉**，让它与真官方行为一致（不拦），
// 这样这一节测的就是**本插件自己那道围栏**。若哪天有人把围栏删了，
// 这里会立刻变红 —— 而不是像以前那样继续绿着。
console.log('\n⑥ 越界必须被本插件挡住（mock 不拦，与真官方一致）');
for (const [method, path] of [
	['fileList', '..'],
	['fileStat', '..'],
	['fileRead', '..'],
	['fileReadBytes', '..'],
	['fileList', '..\\..\\..'],
	['fileStat', '..\\..\\..\\..\\..\\..\\Windows\\win.ini'],
	['fileStat', 'C:\\Windows\\win.ini'],
	['fileList', 'C:\\Windows'],
	['fileRead', '/etc/passwd'],
]) {
	let denied = null;
	try {
		await run(method, { sessionId: SESSION, path });
	} catch (error) {
		denied = error;
	}
	check(`${method} 拒绝越界 ${path}`, denied !== null, denied === null ? '⚠️ 逃逸成功' : '');
}
// ⚠️ 报错文案要能区分「越界」与「文件不存在」：都吞成一句「加载失败」的话，
// 手机端分不清是自己路径写错了还是撞上了围栏。
let fenceMessage = '';
try {
	await run('fileStat', { sessionId: SESSION, path: 'C:\\Windows\\win.ini' });
} catch (error) {
	fenceMessage = String(error.message);
}
check('绝对路径的报错说明是路径问题', fenceMessage.includes('相对路径'), fenceMessage);
let dotdotMessage = '';
try {
	await run('fileStat', { sessionId: SESSION, path: '..\\..\\..' });
} catch (error) {
	dotdotMessage = String(error.message);
}
check('.. 越界的报错说明是越界', dotdotMessage.includes('越出'), dotdotMessage);

// ⚠️ 反向断言：围栏不能**误伤**。区内路径（含看起来像但实为区内的 `..`）必须照常。
console.log('\n⑥.5 围栏不误伤区内路径');
const insideDotDot = await run('fileList', { sessionId: SESSION, path: 'src\\..' });
check('src\\.. 折回根本身（区内）放行', insideDotDot.entries.map((e) => e.name).includes('README.md'));
const sibling = await run('fileStat', { sessionId: SESSION, path: 'src/a.js' });
check('普通相对路径照常', sibling.bytes === 20, String(sibling.bytes));

/** 判两个绝对路径是否同一个（win32 大小写不敏感）。 */
const samePath = (a, b) =>
	process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** 造一个「假兄弟目录」，验前缀比较不会把它误判成区内。 */
const evilDir = `${root}-evil`;
mkdirSync(evilDir, { recursive: true });
writeFileSync(join(evilDir, 'secret.txt'), 'TOPSECRET\n');
let siblingLeak = null;
try {
	await run('fileStat', { sessionId: SESSION, path: `..\\${root.split(/[\\/]/).pop()}-evil\\secret.txt` });
} catch (error) {
	siblingLeak = error;
}
check('同前缀的兄弟目录（ws → ws-evil）被挡住', siblingLeak !== null, siblingLeak === null ? '⚠️ 逃逸成功' : '');
check('兄弟目录确实存在（证明上一条不是因为文件缺失）', statSync(join(evilDir, 'secret.txt')).size === 10);
// 顺手验一下判据本身：`samePath` 只为下面那条大小写断言服务，这里确认它没写反。
check('samePath 自身正确', samePath(root, root.toUpperCase()) === (process.platform === 'win32'));
rmSync(evilDir, { recursive: true, force: true });

console.log('\n⑦ 越界与不存在');
let missing = null;
try {
	await run('fileStat', { sessionId: SESSION, path: 'nope.txt' });
} catch (error) {
	missing = error;
}
check('不存在的文件报错', missing !== null);

// ---- ⑦ 未知会话要给人话 ----
console.log('\n⑦ 未知会话');
let unknown = null;
try {
	await run('fileList', { sessionId: 'no-such-session', path: '' });
} catch (error) {
	unknown = error;
}
check('未知会话报「没有工作目录」', unknown !== null && String(unknown.message).includes('工作目录'), unknown === null ? '没抛错' : String(unknown.message));

// ---- ⑧ 相对路径换算：手机剥前缀 ↔ 电脑透传 ----
//
// ⚠️ 手机端 `mapPath` 没法在这里 import（它埋在 `ctx.effect` 闭包里），
// 所以**照抄**那段剥离逻辑来锁行为 —— 两边走偏了这个测试就会红。
// 这正是 `host-route.mjs` 用的手法。
console.log('\n⑧ 手机端路径剥离（照抄 mapPath）');
const mapPath = (scopePath, desktopRoot, path) => {
	const a = path.replace(/\\/g, '/');
	const b = String(scopePath).replace(/\\/g, '/').replace(/\/+$/, '');
	if (a === b) return { path: '' };
	if (a.startsWith(`${b}/`)) return { path: a.slice(b.length + 1) };
	return { path: a };
};
const mirrorRoot = '/data/user/0/com.dsh.android/files/workspaces/c-users-你的用户名-desktop-c971a62f';
check('根目录 → 空串', mapPath(mirrorRoot, root, mirrorRoot).path === '');
check('根目录带尾斜杠 → 空串', mapPath(mirrorRoot, root, `${mirrorRoot}/`).path === '');
check('子目录 → 相对路径', mapPath(mirrorRoot, root, `${mirrorRoot}/src`).path === 'src');
check('嵌套文件 → 相对路径', mapPath(mirrorRoot, root, `${mirrorRoot}/src/a.js`).path === 'src/a.js');

// 把剥出来的相对路径真的喂给电脑端，证明这一段能接上。
const roundTrip = await run('fileList', { sessionId: SESSION, path: mapPath(mirrorRoot, root, `${mirrorRoot}/src`).path });
check('剥出来的相对路径电脑端认', roundTrip.entries.map((e) => e.name).join(',') === 'a.js', JSON.stringify(roundTrip.entries));

// ---- 收尾 ----
rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
process.exit(failed === 0 ? 0 : 1);
