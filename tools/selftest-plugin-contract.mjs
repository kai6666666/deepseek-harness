#!/usr/bin/env node
/**
 * selftest-plugin-contract.mjs —— 插件契约回归（把三个「静默 bug」变成红灯）
 *
 * 这三条都是**不崩、不报错、只留一行 WARN** 的类型，靠人盯日志必然漏：
 *
 *   ① `provision.json` 没打进 zip
 *      → 插件加载时降级为空表，工具注册成功但所有后端配置为空
 *      → 看起来能用，实际什么都装不了（真机现象：`provision.json 读取失败`）
 *
 *   ② `virtualPrefix` 从错的层级读
 *      → 该字段在 `backends.<name>`，不在 `groups.<key>.<backend>`
 *      → 写了个「已支持」，分支永远走不到
 *
 *   ③ `inject` 少声明 `tools`
 *      → DSH 的 ctx 是 Proxy，未 inject 的属性访问**在 getter 里就抛**
 *      → `ctx.tools?.register` 的 `?.` 救不了，工具静默不注册
 *
 * 外加两条已有的硬约束，一起守住：
 *   ④ 两处 spawn 都带 `detached: true`，超时走 `killTree(child)`（G-13）
 *   ⑤ EngineManager 真的把 zip 解出来并挂上了 overlay（不是只有 assets 里躺着）
 *
 * 用法：node tools/selftest-plugin-contract.mjs
 * 退出码：0 全过；1 有失败
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const ZIP = join(root, "app/src/main/assets/dsh-android-toolchain.zip");
const SRC = join(root, "plugin-src/dsh-android-toolchain");
const ENGINE = join(root, "app/src/main/java/com/dsh/android/EngineManager.kt");

let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => {
  console.error(`✗ ${m}`);
  failed += 1;
};

/* ── ① zip 内容齐不齐 ─────────────────────────────────────────────── */
if (!existsSync(ZIP)) {
  bad(`缺 ${ZIP}（插件没打包，APK 里就不会有它）`);
} else if (!existsSync(join(root, "app/src/main/assets"))) {
  bad("assets 目录不存在");
} else {
  // 用 unzip 列条目（zip 很小，且 CI runner 一定有 unzip）
  const r = spawnSync("unzip", ["-Z1", ZIP], { encoding: "utf8" });
  if (r.status !== 0) {
    bad(`unzip 读不了 ${ZIP}: ${(r.stderr || "").trim().slice(0, 120)}`);
  } else {
    const names = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const need = ["package.json", "provision.json", "lib/index.js"];
    const missing = need.filter((n) => !names.includes(n));
    if (missing.length === 0) ok(`zip 内容齐（${need.join(" + ")}）`);
    else bad(`zip 里缺：${missing.join(", ")} —— ① provision.json 就是漏在这里的`);
  }
}

/* ── provision.json 的后端表 ──────────────────────────────────────── */
let provision = null;
try {
  provision = JSON.parse(readFileSync(join(SRC, "provision.json"), "utf8"));
} catch (e) {
  bad(`读不了 plugin-src 的 provision.json: ${e.message}`);
}
if (provision) {
  const alp = provision.backends?.alpine;
  if (alp?.virtualPrefix === "--virtual") ok("provision.json: alpine.virtualPrefix = --virtual");
  else bad(`provision.json: alpine.virtualPrefix = ${JSON.stringify(alp?.virtualPrefix)}（应为 "--virtual"）`);
  if (Array.isArray(alp?.install) && alp.install.includes("{pkgs}")) ok("provision.json: alpine.install 带 {pkgs} 占位");
  else bad("provision.json: alpine.install 缺 {pkgs} 占位（expand 会拼不出命令）");
  const groups = Object.keys(provision.groups ?? {});
  if (groups.length > 0) ok(`provision.json: ${groups.length} 个依赖组（${groups.slice(0, 6).join(", ")}…）`);
  else bad("provision.json: groups 为空");
}

/* ── index.js 的三条契约 ─────────────────────────────────────────── */
let js = "";
try {
  js = readFileSync(join(SRC, "lib/index.js"), "utf8");
} catch (e) {
  bad(`读不了 lib/index.js: ${e.message}`);
}
if (js) {
  // ② inject 必须含 tools
  const m = js.match(/export const inject = \[([^\]]*)\]/);
  if (!m) bad("index.js: 找不到 export const inject");
  else if (/"tools"/.test(m[1])) ok(`index.js: inject = [${m[1].replace(/\s+/g, " ").trim()}]（含 tools）`);
  else bad(`index.js: inject = [${m[1]}] —— 缺 "tools"，工具会静默不注册（③）`);

  // ② virtualPrefix 必须从 backend 层读
  if (/backend\.virtualPrefix/.test(js)) ok("index.js: virtualPrefix 读 backend 层（对）");
  else bad("index.js: 没读 backend.virtualPrefix —— 从 groups 层读永远是 undefined（②）");
  if (/spec\?\.virtualPrefix/.test(js)) bad("index.js: 仍在读 spec?.virtualPrefix（错的层级）");

  // ⑤ 每个 register 都必须带 output —— 漏一个，整段 register 一起失败
  //    真机实证：先只补了 android_toolchain，报错就换成了 android_native_precheck；
  //    两个都补上之后 "注册失败/TypeError" 计数归零。
  const regCount = (js.match(/ctx\.tools\.register\(\{/g) ?? []).length;
  const outCount = (js.match(/output: \{/g) ?? []).length;
  if (regCount > 0 && outCount >= regCount) ok(`index.js: ${regCount} 个工具都声明了 output`);
  else bad(`index.js: register ${regCount} 个 / output ${outCount} 个 —— 漏一个则全部不注册`);

  // ④ G-13 进程组
  const detached = (js.match(/detached: true/g) ?? []).length;
  const killTreeCalls = (js.match(/killTree\(child\)[,;)]/g) ?? []).length;
  if (detached === 2) ok("index.js: 两处 spawn 都 detached:true");
  else bad(`index.js: detached:true 出现 ${detached} 次（应为 2）`);
  if (killTreeCalls === 2) ok("index.js: 两处超时都走 killTree(child)");
  else bad(`index.js: killTree(child) 调用 ${killTreeCalls} 次（应为 2）`);
}

/* ── ⑤ EngineManager 真的接线了 ──────────────────────────────────── */
if (!existsSync(ENGINE)) {
  bad(`缺 ${ENGINE}`);
} else {
  const kt = readFileSync(ENGINE, "utf8");
  const checks = [
    ['TOOLCHAIN_TOOL_ASSET = "dsh-android-toolchain.zip"', "常量指向正确的 zip"],
    ["private fun ensureToolchainTool()", "有 ensureToolchainTool()"],
    ["private fun writeToolchainToolPatch(): File?", "有 writeToolchainToolPatch()"],
    ["ensureToolchainTool()", "启动流程里调用了 ensureToolchainTool()"],
    ["toolchainToolPatch,", "overlay 已进 --patch 收集列表"],
  ];
  for (const [needle, label] of checks) {
    if (kt.includes(needle)) ok(`EngineManager: ${label}`);
    else bad(`EngineManager: ${label} —— 找不到 ${JSON.stringify(needle)}`);
  }
}

console.log(`\n结果: ${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);