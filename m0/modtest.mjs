// 用假 ctx 直接验证插件：能否 import、apply 注册了哪些工具、execute 是否存在
const p = '/usr/local/lib/node_modules/dsh-android-bridge/lib/index.js';
const m = await import(p);
console.log('exports', Object.keys(m));
console.log('name=', m.name, 'inject=', JSON.stringify(m.inject));

const regs = [];
const ctx = {
  tools: { register: (t) => regs.push({ name: t.name, hasExec: typeof t.execute === 'function', hasOut: !!t.output }) },
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a) },
};
m.apply(ctx);
console.log('registered', regs.length, JSON.stringify(regs));
