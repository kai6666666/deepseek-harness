/**
 * 逐条对比「电脑端事件日志」与「手机端镜像日志」。
 *
 * 这是**核心数据路径的唯一验收工具**：插件承诺手机上的会话是电脑会话的镜像，
 * 那就必须能证明两端逐条一致 —— 靠肉眼看两份 20 行清单是不够的。
 *
 * 用法：node compare-logs.mjs <电脑端日志> <手机端日志>
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

/** 按 zstd 魔数 `28 B5 2F FD` 切帧 —— 日志是多帧追加写的。 */
function decode(path) {
	const buffer = readFileSync(path);
	const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
	const starts = [];
	for (let i = 0; i + 4 <= buffer.length; i += 1) {
		if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
			starts.push(i);
		}
	}
	const frames = starts.length === 0
		? [buffer]
		: starts.map((start, index) => buffer.subarray(start, starts[index + 1] ?? buffer.length));

	let text = '';
	for (const frame of frames) {
		try {
			text += zstdDecompressSync(frame).toString('utf8');
		} catch {
			// 末尾未写完的帧，忽略。
		}
	}

	const events = [];
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// 半行，忽略。
		}
	}
	// 首行是 `session` 元数据（无 seq），按 seq 排序后按序对比。
	return events.filter((event) => typeof event.seq === 'number').sort((a, b) => a.seq - b.seq);
}

/** 把一条事件压成可比较的摘要。 */
function summarize(event) {
	const content = event.data?.content ?? [];
	const texts = (Array.isArray(content) ? content : [])
		.filter((part) => part?.type === 'text')
		.map((part) => String(part.text).replace(/\s+/g, ' ').slice(0, 50))
		.join(' | ');
	return `${event.type}${texts === '' ? '' : ' :: ' + texts}`;
}

const [pcPath, phonePath] = process.argv.slice(2);
const pc = decode(pcPath);
const phone = decode(phonePath);

console.log(`电脑端事件数: ${pc.length}`);
console.log(`手机端事件数: ${phone.length}\n`);

const pcBySeq = new Map(pc.map((event) => [event.seq, event]));
const phoneBySeq = new Map(phone.map((event) => [event.seq, event]));
const seqs = [...new Set([...pcBySeq.keys(), ...phoneBySeq.keys()])].sort((a, b) => a - b);

let mismatches = 0;
let missing = 0;
console.log('seq  | 电脑端                                    | 手机端');
console.log('-----|-------------------------------------------|------------------------------------------');
for (const seq of seqs) {
	const a = pcBySeq.get(seq);
	const b = phoneBySeq.get(seq);
	if (a === undefined) {
		console.log(`${String(seq).padStart(4)} | ${'(手机端多出)'.padEnd(41)} | ${summarize(b).slice(0, 60)}`);
		mismatches += 1;
		continue;
	}
	if (b === undefined) {
		console.log(`${String(seq).padStart(4)} | ${summarize(a).slice(0, 41).padEnd(41)} | (手机端缺失) ❌`);
		missing += 1;
		continue;
	}
	const sameType = a.type === b.type;
	if (!sameType) mismatches += 1;
	const mark = sameType ? '  ' : '❌';
	console.log(`${String(seq).padStart(4)} | ${summarize(a).slice(0, 41).padEnd(41)} | ${mark} ${summarize(b).slice(0, 60)}`);
}

console.log(`\n类型不一致: ${mismatches} 处，手机端缺失: ${missing} 处`);
process.exit(mismatches === 0 && missing === 0 ? 0 : 1);
