#!/data/data/com.dsh.android/files/usr/bin/bash
# dsh-plugin-compat.sh —— 装之前先判：这个 DSH 插件在 Android 上能不能跑
# 用法： bash tools/dsh-plugin-compat.sh <npm-pkg> [更多包...]
# 依赖：node（Termux/PRoot 里的都行）+ npm（只用于 `npm view`）
set -u

if [ $# -lt 1 ]; then
  printf 'usage: %s <npm-pkg> [pkg...]\n' "$0"
  exit 2
fi

command -v node >/dev/null 2>&1 || { printf '需要 node 在 PATH 里\n'; exit 2; }

for pkg in "$@"; do
  printf '\n=== %s ===\n' "$pkg"
  if ! npm view "$pkg" --json >/tmp/dshpkg.json 2>/tmp/dshpkg.err; then
    printf 'NOT_FOUND  %s\n' "$(tail -1 /tmp/dshpkg.err)"
    continue
  fi
  node -e '
const fs = require("node:fs");
const m = JSON.parse(fs.readFileSync("/tmp/dshpkg.json", "utf8"));
const deps = { ...(m.dependencies||{}), ...(m.optionalDependencies||{}), ...(m.peerDependencies||{}) };
const NATIVE = [/^sharp$/, /^@img\/sharp-/, /^@vscode\/ripgrep$/, /^node-pty$/,
                /^node-addon-/, /^@deepseek-ai\/node-addon-/, /^better-sqlite3$/,
                /^@napi-rs\//, /^koffi$/, /^onnxruntime-node$/, /^duckdb$/];
const hits = Object.keys(deps).filter(d => NATIVE.some(r => r.test(d)));
const eng  = (m.engines && m.engines.dsh) || (m.peerDependencies||{})["@deepseek-ai/dsh"] || "(none)";
const okBundle = !!(m.dsh && m.dsh.bundle && m.dsh.bundle.patch);
const hasClient = !!(m.dsh && m.dsh.client);

console.log("version     :", m.version || "?");
console.log("bundle.patch:", okBundle ? "YES" : "NO  → 市场会标『无法作为插件包安装』");
console.log("client half :", hasClient ? "YES" : "no");
console.log("engines.dsh :", eng);
console.log("native deps :", hits.length ? hits.join(", ") : "(none)");

let verdict;
if (!okBundle) verdict = "❌ 装不上（缺 dsh.bundle.patch）";
else if (hits.length) verdict = "⚠️ 高风险：需要 android/musl 原生产物，否则会装不上或静默失效";
else verdict = "✅ 纯 JS，可直接装";

// android 专属提醒
if (process.platform === "android") {
  verdict += "  ｜ 注意 process.platform=android，三平台判断的分支不会进入";
}
console.log("判定        :", verdict);
' 
done

printf '\n提示：判定为 ⚠️ 时，先跑 dsh plugin add 之前用 dsh-android-toolchain 的 precheck 确认编译链。\n'
