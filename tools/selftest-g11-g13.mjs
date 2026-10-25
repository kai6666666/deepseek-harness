#!/usr/bin/env node
/**
 * selftest-g11-g13.mjs —— 两个小修的回归自检
 *
 * G-11（锚点自动重定位）：构造「上游只改了缩进 + 前置一行注释」的场景，
 *   精确子串必然 miss，要求 apply-patches.mjs 打印 ↻ 并 exit 0。
 *   同时反证严格模式 --no-relocate 必须 exit 1（说明开关真的有效）。
 *
 * G-13（杀整个进程组）：index.js 是插件模块，直接 import 会拉依赖，
 *   所以这里做静态断言：detached:true 出现 2 次、killTree(child) 出现在
 *   两处超时路径、且超时路径里不再有裸 child.kill("SIGKILL")。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const applier = join(here, "apply-patches.mjs");
// plugin-src 的位置有两种：本地工作区（仓库外）与仓库内。都试一遍，别硬编码。
const idxCandidates = [
  join(root, "plugin-src/dsh-android-toolchain/lib/index.js"),
  resolve(root, "..", "plugin-src/dsh-android-toolchain/lib/index.js"),
];
const idx = idxCandidates.find((p) => existsSync(p));
if (!idx) {
  console.error(`✗ 找不到 plugin index.js，试过：\n  ${idxCandidates.join("\n  ")}`);
  process.exit(1);
}

let failed = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const bad = (msg) => {
  console.error(`✗ ${msg}`);
  failed += 1;
};

/* ── G-11 ──────────────────────────────────────────────────────────── */
const FIND = ["function foo() {", "  return 1;", "}"].join("\n");
const REPLACE = ["function foo() {", "  return 2;", "}"].join("\n");
const TARGET = [
  "// 上游新加的一行注释，锚点整体下移",
  "  function foo() {",
  "      return 1;",
  "  }",
  "// tail",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "g11-"));
mkdirSync(dir, { recursive: true });
// apply-patches.mjs 有前置校验：root 下必须有 node_modules，否则判「不是引擎根」exit 2
mkdirSync(join(dir, "node_modules"), { recursive: true });
writeFileSync(join(dir, "target.js"), TARGET, "utf8");
writeFileSync(
  join(dir, "manifest.json"),
  JSON.stringify({
    patches: [
      {
        kind: "text",
        id: "relocate-selftest",
        file: "target.js",
        find: FIND,
        replace: REPLACE,
        requireCount: 1,
        why: "selftest：缩进与前置注释变化，锚点必须能自动重定位",
      },
    ],
  }),
  "utf8",
);

const run = (extra) =>
  spawnSync(process.execPath, [applier, "--root", dir, "--manifest", join(dir, "manifest.json"), "--dry-run", ...extra], {
    encoding: "utf8",
  });

const loose = run([]);
if (loose.status === 0 && loose.stdout.includes("锚点重定位")) {
  ok(`G-11 重定位生效（exit=0，日志含「锚点重定位」）`);
  const line = loose.stdout.split("\n").find((l) => l.includes("锚点重定位"));
  console.log(`    ${line.trim()}`);
} else {
  bad(`G-11 重定位未生效：exit=${loose.status}\n${loose.stdout}\n${loose.stderr}`);
}

const strict = run(["--no-relocate"]);
if (strict.status === 1) {
  ok(`G-11 --no-relocate 严格模式仍然 fail-fast（exit=1）`);
} else {
  bad(`G-11 严格模式异常：exit=${strict.status}（应为 1）`);
}
if (strict.stderr.includes("候选")) {
  ok(`G-11 失败时给出候选诊断（含「候选 第N行 相似度」）`);
} else {
  bad(`G-11 失败诊断缺失：\n${strict.stderr}`);
}

/* ── G-13 ──────────────────────────────────────────────────────────── */
const src = readFileSync(idx, "utf8");
const detached = (src.match(/detached: true/g) ?? []).length;
// 注意：只数「调用」——一处是 `killTree(child);`，另一处是 `setTimeout(() => killTree(child), 600_000)`，
// 后面跟的是 `)` 不是 `;`。函数定义 `function killTree(child) {` 后面是 `{`，不会被算进来。
const killTreeCalls = (src.match(/killTree\(child\)[,;)]/g) ?? []).length;
const bareKills = (src.match(/child\.kill\("SIGKILL"\)/g) ?? []).length;
const helper = /function killTree\(child\)/.test(src);

if (helper) ok("G-13 killTree() helper 存在");
else bad("G-13 缺 killTree helper");
if (detached === 2) ok("G-13 两处 spawn 都带 detached:true（子进程成为进程组 leader）");
else bad(`G-13 detached:true 出现 ${detached} 次（应为 2）`);
if (killTreeCalls === 2) ok("G-13 两处超时路径都改走 killTree(child)");
else bad(`G-13 killTree(child) 出现 ${killTreeCalls} 次（应为 2）`);
// killTree 自己内部有 2 处兜底 child.kill，其它地方应为 0
if (bareKills === 2) ok("G-13 裸 child.kill 只剩 killTree 内 2 处兜底，超时路径已无裸杀");
else bad(`G-13 裸 child.kill 出现 ${bareKills} 处（应为 2，全在 killTree 内）`);

console.log(`\n结果: ${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
