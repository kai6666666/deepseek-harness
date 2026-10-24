/**
 * 只做「注册 + 生成配对码」，把 6 位码打到 stdout 就退出。
 *
 * 用来配合手机端做真实配对：先在电脑侧把码生成出来，
 * 再在手机上 `pair` 那个码，验手机写盘与状态切换。
 *
 * 用法：node make-code.mjs <激活码>
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairing } from '../dsh-remote-desktop/lib/pair.js';

const CODE = process.argv[2];
if (!CODE) {
	console.error('用法: node make-code.mjs <激活码>');
	process.exit(2);
}

const logger = { info() {}, warn: (m) => console.error('[warn]', m) };
const pairing = createPairing({ stateDir: mkdtempSync(join(tmpdir(), 'dsh-mk-')), logger });

const registered = await pairing.register(CODE);
if (!registered.ok) {
	console.error('注册失败:', registered.message);
	process.exit(1);
}
const handshake = await pairing.handshake();
if (handshake.ok !== true) {
	console.error('生成配对码失败:', handshake.message);
	process.exit(1);
}
console.log(JSON.stringify({
	pairCode: handshake.pairCode,
	hostname: registered.record?.hostname ?? registered.hostname,
	accessToken: registered.record?.accessToken ?? registered.accessToken,
}));
