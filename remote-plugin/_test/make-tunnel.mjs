/**
 * 注册一个激活码并把连接信息（含 tunnelToken）打到 stdout。
 *
 * 用途：配合真机/本机做「隧道是否真能连上 Cloudflare 边缘」的验证 ——
 * `make-code.mjs` 只打印手机需要的三样（配对码/hostname/accessToken），
 * 而起 cloudflared 需要的是 **tunnelToken**，所以单独一个脚本。
 *
 * ⚠️ 会把 `tunnelToken` 打到 stdout，只在本机调试时用，别把输出贴到别处。
 *
 * 用法：node make-tunnel.mjs <激活码>
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairing } from '../dsh-remote-desktop/lib/pair.js';

const CODE = process.argv[2];
if (!CODE) {
	console.error('用法: node make-tunnel.mjs <激活码>');
	process.exit(2);
}

const pairing = createPairing({
	stateDir: mkdtempSync(join(tmpdir(), 'dsh-tun-')),
	logger: { info() {}, warn: (m) => console.error('[warn]', m) },
});

const reg = await pairing.register(CODE);
if (!reg.ok) {
	console.error('注册失败:', reg.message);
	process.exit(1);
}
console.log(
	JSON.stringify({
		hostname: reg.record.hostname,
		subdomain: reg.record.subdomain,
		tunnelToken: reg.record.tunnelToken,
		accessToken: reg.record.accessToken,
	}),
);
