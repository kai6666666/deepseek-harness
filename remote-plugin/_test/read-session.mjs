/**
 * 解出电脑端会话日志，把关键事件打出来。
 *
 * 用来验证「手机发消息 → 电脑 agent 真跑 → 回复落盘」这条链路，
 * 而不必依赖手机 UI（避免污染用户正在用的真实会话）。
 *
 * 用法：node read-session.mjs <会话日志路径>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
const raw = readFileSync(path);

/**
 * ⚠️ 日志是**多帧 zstd 追加写**的（每批一个独立帧），
 * 直接对整份文件调一次 `zstdDecompressSync` 只能解出第一帧，
 * 看起来就像「只有一个 session 事件、之后什么都没有」——
 * 那是解析假象，不是日志真的没内容。
 *
 * 这里按 zstd 魔数 `28 B5 2F FD` 切帧，逐帧解后拼接。
 */
function splitFrames(buffer) {
	const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
	const starts = [];
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
			starts.push(i);
		}
	}
	if (starts.length === 0) return [buffer];
	return starts.map((start, index) => buffer.subarray(start, starts[index + 1] ?? buffer.length));
}

const frames = splitFrames(raw);
console.log(`zstd 帧数: ${frames.length}`);

let text = '';
let failed = 0;
for (const frame of frames) {
	try {
		text += zstdDecompressSync(frame).toString('utf8');
	} catch {
		failed += 1;
	}
}
if (failed > 0) console.log(`（${failed} 帧解压失败，多半是末尾未写完的帧）`);

const lines = text.split('\n').filter((l) => l.trim() !== '');
console.log(`事件总数: ${lines.length}`);

const counts = new Map();
for (const line of lines) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		continue;
	}
	const type = event.type ?? '?';
	counts.set(type, (counts.get(type) ?? 0) + 1);
}
console.log('事件类型统计:');
for (const [type, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${String(n).padStart(4)}  ${type}`);
}

/**
 * 按 seq 顺序列出全部事件（类型 + seq），用于两端逐条对齐比较。
 *
 * 参数：
 *   argv[2] = 日志路径
 *   argv[3] = 'seq' 时输出逐条清单（默认只输出统计）
 */
const listMode = process.argv[3] === 'seq';
if (listMode) {
	console.log('\n--- 逐条事件（seq 顺序） ---');
	for (const line of lines) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const content = event.data?.content ?? [];
		const texts = (Array.isArray(content) ? content : [])
			.filter((part) => part?.type === 'text')
			.map((part) => String(part.text).replace(/\s+/g, ' ').slice(0, 60))
			.join(' | ');
		// title 类事件要把 data 也打出来：两端 title 是否由**本地**生成，
		// 只有看内容才判断得出（seq 对齐不代表内容同源）。
		const extra = /title/.test(String(event.type))
			? '  data=' + JSON.stringify(event.data).slice(0, 160)
			: '';
		console.log(`  seq=${String(event.seq).padStart(4)}  ${event.type}${texts === '' ? '' : '  :: ' + texts}${extra}`);
	}
}

console.log('\n--- 文本内容（user / assistant） ---');
for (const line of lines) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		continue;
	}
	if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
	const content = event.data?.content ?? event.data?.message?.content ?? [];
	const texts = (Array.isArray(content) ? content : [])
		.filter((part) => part?.type === 'text')
		.map((part) => part.text)
		.join(' ');
	if (texts.trim() !== '') console.log(`[${event.type}] ${texts.slice(0, 200)}`);
}
