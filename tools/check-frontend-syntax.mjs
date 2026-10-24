/*
 * 独立语法校验：用 acorn 解析前端 bundle，**遍历 AST 找具体的语法特性**，
 * 按各特性在 Chrome 中的实际落地版本判定，而不是看 ECMAScript 版本号。
 *
 * ── 为什么不能直接看 ecmaVersion ────────────────────────────────────
 *
 * `acorn.parse({ ecmaVersion: 2019 })` 会拒绝 class 私有字段，因为它在
 * **标准**里属于 ES2022。但 **Chrome 74 早就实现了它**（私有字段随 Chrome 74
 * 发布，公开字段更早）。也就是说：
 *
 *     ECMAScript 版本号 ≠ Chrome 版本号
 *
 * 拿 ES2019 当「chrome74」用会把一堆其实能跑的特性误判成缺口 ——
 * 实测降级产物在 ES2019 下报「需要 ES2022」，而真因只是私有字段。
 *
 * ── 正确做法 ────────────────────────────────────────────────────────
 *
 * 用 acorn 以最高版本解析（保证能建出 AST），再遍历 AST 找**具体节点**，
 * 按下面这张「特性 → 最低 Chrome 版本」表逐个判定。这张表才是真正的门槛。
 *
 * ⚠️ 只覆盖**语法**。`Object.hasOwn` / `.at()` / `WeakRef` 这类是**运行时 API**，
 *   解析器看不见，由 `webview-polyfill.js` 负责（见该文件对应段落）。
 *
 * ── 调用方 ──────────────────────────────────────────────────────────
 *
 * `tools/build-webview-compat.ps1` 的复检环节会**无人值守**地调它，所以：
 *   · `acorn` 缺失时**自己装一份**到临时目录（不要要求调用方先 npm install）；
 *   · 退出码要能区分「真有语法缺口(1)」与「工具本身跑不起来(2)」——
 *     否则环境问题会被误报成「降级失败」，排查方向直接跑偏。
 *
 * 用法：node tools/check-frontend-syntax.mjs [--target 74] <文件...>
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

/**
 * 取 acorn：先本仓库，再全局，最后**自己装一份**。
 *
 * ⚠️ 本仓库**没有** `package.json` / `node_modules`（这是个 Android 工程，
 *    JS 只在 `tools/` 下当构建期脚本用），所以「找不到 acorn」是**常态**而非异常。
 *    早先没这段兜底时，`Cannot find module 'acorn'` 会被上层当成语法不合格，
 *    于是每个文件都「失败」—— 实测报出 72 个「降级失败」，真因其实一个都没有。
 */
async function loadAcorn() {
  try {
    return require('acorn');
  } catch {
    /* 落到下面自装 */
  }
  const dir = join(tmpdir(), 'dsh-syntax-check');
  const marker = join(dir, 'node_modules', 'acorn', 'package.json');
  if (!existsSync(marker)) {
    process.stderr.write('安装 acorn（构建期工具，不进仓库）…\n');
    const env = { ...process.env };
    // 与 build-webview-compat.ps1 同一个代理：本机直连 npm 会超时
    if (!env.HTTPS_PROXY) env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    if (!env.HTTP_PROXY) env.HTTP_PROXY = 'http://127.0.0.1:7897';
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', 'acorn@8', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error'],
      { stdio: 'inherit', env, shell: process.platform === 'win32' }
    );
  }
  return createRequire(join(dir, 'index.cjs'))('acorn');
}

let acorn;
try {
  acorn = await loadAcorn();
} catch (e) {
  // 退出码 2：工具跑不起来 ≠ 产物有语法缺口。调用方必须能把这两者分开。
  console.error(`无法加载 acorn，校验未能执行（不是语法问题）: ${e.message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let target = 74;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--target') target = Number(argv[++i]);
  else files.push(argv[i]);
}
if (files.length === 0) {
  console.error('用法: node check-frontend-syntax.mjs [--target 74] <文件...>');
  process.exit(2);
}

/**
 * 语法特性 → 最低 Chrome 版本。
 *
 * 版本号取自 MDN / caniuse 的「Chrome 首次支持」列。刻意保守：
 * 有疑问就往高了写，宁可多报一处也不要漏报（漏报的后果是白屏）。
 */
const FEATURES = {
  'class static block (static {})': { chrome: 94, match: (n) => n.type === 'StaticBlock' },
  'class private method (#m(){})': {
    chrome: 84,
    match: (n) => n.type === 'MethodDefinition' && n.key && n.key.type === 'PrivateIdentifier',
  },
  'class private accessor': {
    chrome: 84,
    match: (n) =>
      (n.type === 'PropertyDefinition' || n.type === 'MethodDefinition') &&
      n.key && n.key.type === 'PrivateIdentifier' &&
      (n.kind === 'get' || n.kind === 'set'),
  },
  'logical assignment (||= &&= ??=)': {
    chrome: 85,
    match: (n) =>
      n.type === 'AssignmentExpression' && ['||=', '&&=', '??='].includes(n.operator),
  },
  'optional chaining (?.)': { chrome: 80, match: (n) => n.type === 'ChainExpression' },
  'nullish coalescing (??)': {
    chrome: 80,
    match: (n) => n.type === 'LogicalExpression' && n.operator === '??',
  },
  'numeric separator (1_000)': {
    chrome: 75,
    // ⚠️ 只看**数值**字面量。早先写成「raw 匹配 /[0-9]_/」会把字符串误判进来 ——
    //    字符串的 `raw` 是含引号的原文，`"a1_2"` 一样能匹配上（实测误报 152 处）。
    match: (n) =>
      n.type === 'Literal' &&
      (typeof n.value === 'number' || typeof n.value === 'bigint') &&
      typeof n.raw === 'string' &&
      n.raw.includes('_'),
  },
  'top-level await': {
    chrome: 89,
    match: (n) => n.type === 'AwaitExpression' && n.__topLevel === true,
  },
  'RegExp d 标志 (indices)': {
    chrome: 90,
    match: (n) => n.type === 'Literal' && n.regex && n.regex.flags.includes('d'),
  },
  'RegExp v 标志': {
    chrome: 112,
    match: (n) => n.type === 'Literal' && n.regex && n.regex.flags.includes('v'),
  },
  'import assertions / attributes': {
    chrome: 91,
    match: (n) => (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration') &&
      Array.isArray(n.attributes) && n.attributes.length > 0,
  },
  'hashbang': { chrome: 74, match: (n) => n.type === 'Hashbang' },
};

/** 递归遍历 AST，对每个节点跑所有匹配器。 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
    } else if (value && typeof value === 'object') {
      walk(value, visit);
    }
  }
}

/**
 * 标注**真正的**顶层 await。
 *
 * ⚠️ 不能「遍历顶层语句里的所有 AwaitExpression」—— 那样会把 async 函数体内的
 *    `await` 也算进来，而函数体里的 await 从 ES2017 就合法，与 chrome89 无关。
 *    实测这样误报了 44 处。必须**遇到函数边界就停下**。
 */
function markTopLevelAwait(ast) {
  const STOP = new Set([
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  ]);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node.type !== 'string') return;
    // 进了函数体就不再往下 —— 那里的 await 是 async 函数的一部分
    if (STOP.has(node.type)) return;
    if (node.type === 'AwaitExpression') node.__topLevel = true;
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      visit(node[key]);
    }
  }
  for (const stmt of ast.body) visit(stmt);
}

let allOk = true;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    // 用最高版本解析：只求能建出 AST，判定交给下面的特性表
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (e) {
    allOk = false;
    console.log(`FAIL ${file}\n     解析失败: ${e.message}`);
    continue;
  }
  markTopLevelAwait(ast);

  const found = new Map();
  walk(ast, (n) => {
    for (const [name, feat] of Object.entries(FEATURES)) {
      if (feat.match(n)) found.set(name, (found.get(name) || 0) + 1);
    }
  });

  const violations = [...found.entries()].filter(([name]) => FEATURES[name].chrome > target);
  if (violations.length === 0) {
    const worst = [...found.entries()].sort((a, b) => FEATURES[b[0]].chrome - FEATURES[a[0]].chrome)[0];
    console.log(
      `OK   ${file}\n` +
        `     无 chrome${target} 以上的语法` +
        (worst ? `（最高用到: ${worst[0]} → chrome${FEATURES[worst[0]].chrome}）` : '（未用到任何受限特性）')
    );
  } else {
    allOk = false;
    console.log(`FAIL ${file}  ← 旧内核解析不了`);
    for (const [name, count] of violations.sort((a, b) => FEATURES[b[0]].chrome - FEATURES[a[0]].chrome)) {
      console.log(`     ×${String(count).padEnd(4)} ${name}  (需 chrome${FEATURES[name].chrome}+)`);
    }
  }
}

process.exit(allOk ? 0 : 1);
