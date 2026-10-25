#!/usr/bin/env node
/**
 * gen-version-matrix.mjs —— 生成 / 校验 docs/agents/version-matrix.md（G-15）
 *
 * 为什么需要它：DSH 版本 × rootfs 版本 × node 版本 × proot 版本之间没有一张对照表，
 * 出问题时要靠人回忆「这个 APK 里配的是哪版 rootfs」。这张表由**单一来源**生成，
 * 就不存在「文档写着 A、包里其实是 B」。
 *
 * 数据来源（全部是仓库里的真实文件，不联网）：
 *   · APK 版本      app/build.gradle.kts           versionCode / versionName
 *   · rootfs        app/src/main/assets/runtime/alpine-rootfs.manifest.json
 *   · proot 三件套  app/src/main/jniLibs/arm64-v8a/ 是否存在 + PROOT_PIN 常量
 *   · Kotlin 门面   runtime/RuntimePaths.kt / AlpineProvisioner.kt 的关键常量
 *
 * 用法：
 *   node tools/gen-version-matrix.mjs            # 写文件
 *   node tools/gen-version-matrix.mjs --check    # 只校验（不一致 exit 1，可挂 CI）
 *   node tools/gen-version-matrix.mjs --stdout
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const OUT = join(root, "docs/agents/version-matrix.md");

/** proot 三件套的钉死版本（换版本时改这里 + 更新来源说明）。 */
const PROOT_PIN = {
  proot: "5.1.107.101",
  talloc: "2.5.0",
  shmem: "0.7",
  source: "packages.termux.dev/apt/termux-main（aarch64 deb 提取，见 tools/proot/README.md）",
};

const read = (p) => readFileSync(join(root, p), "utf8");
const grab = (text, re, fallback = "?") => {
  const m = text.match(re);
  return m ? m[1] : fallback;
};

const gradle = read("app/build.gradle.kts");
const versionCode = grab(gradle, /versionCode\s*=\s*(\d+)/);
const versionName = grab(gradle, /versionName\s*=\s*"([^"]+)"/);

const manifestPath = "app/src/main/assets/runtime/alpine-rootfs.manifest.json";
const manifest = JSON.parse(read(manifestPath));

const jni = "app/src/main/jniLibs/arm64-v8a";
const soFiles = ["libproot.so", "libtalloc.so", "libandroid-shmem.so"];
const soState = soFiles.map((f) => `${f} ${existsSync(join(root, jni, f)) ? "✓" : "✗"}`).join(" / ");

const provisioner = read("app/src/main/java/com/dsh/android/runtime/AlpineProvisioner.kt");
const safetyMb = grab(provisioner, /SAFETY_MARGIN\s*=\s*(\d+)L\s*\*\s*1024/, "?");

const lines = [
  "# 版本矩阵（G-15）",
  "",
  "> 本文件由 `tools/gen-version-matrix.mjs` **自动生成**，不要手改。",
  "> 校验：`node tools/gen-version-matrix.mjs --check`（CI 里挂闸门）。",
  "",
  "## 1. 一个 APK 里到底装了什么",
  "",
  "| 组件 | 版本 | 来源（仓库内路径） |",
  "|---|---|---|",
  `| DSH Android 客户端 | \`versionCode ${versionCode}\` / \`${versionName}\` | \`app/build.gradle.kts\` |`,
  `| Alpine rootfs | alpine \`${manifest.alpine}\` | \`${manifestPath}\` |`,
  `| Node（guest 内） | \`${manifest.nodejs}\` | 同上 |`,
  `| rootfs 包体 | \`${manifest.bytes}\` B / sha256 \`${String(manifest.sha256).slice(0, 16)}…\` | 同上 |`,
  `| rootfs 构建时间 | \`${manifest.builtAt ?? "?"}\` | 同上 |`,
  `| proot | \`${PROOT_PIN.proot}\` | ${PROOT_PIN.source} |`,
  `| libtalloc | \`${PROOT_PIN.talloc}\` | 同上 |`,
  `| libandroid-shmem | \`${PROOT_PIN.shmem}\` | 同上 |`,
  `| jniLibs 实况 | ${soState} | \`${jni}/\` |`,
  `| 解包安全水位 | \`${safetyMb}\` MB | \`AlpineProvisioner.SAFETY_MARGIN\` |`,
  "",
  "## 2. rootfs 里的关键包",
  "",
  "```text",
  ...(manifest.packages ?? []).map((p) => `- ${p}`),
  "```",
  "",
  "## 3. 兼容边界（出问题先看这里）",
  "",
  "| 维度 | 约束 | 违反后的症状 |",
  "|---|---|---|",
  "| ABI | 只支持 `arm64-v8a` / `x86_64`（`Abi.SUPPORTED`） | `ProotMissing`→其实是 `UnsupportedAbi`；提前判定，日志会写明设备 ABI |",
  "| libc | bionic（Android），**不是** glibc/musl | `Exec format error` / `libc.so.6: not found` |",
  "| 落地路径 | 必须在 `filesDir` 之下（`RuntimePaths.assertExecutableRoot`） | `/storage`、`/sdcard` 是 FUSE noexec → node 无法 exec |",
  "| Node ABI | N-API 8（跨 Node 20/22/24/26 稳定） | 插件 `.node` 加载失败 |",
  "| 空间 | 解包需 ≥ `包体 × 3` 或 `上次实测 × 1.1`，且过程中留 80 MB | 半途 ENOSPC → 已清理 staging，可重试 |",
  "",
  "## 4. 升级时要一起动的东西",
  "",
  "```text",
  "换 rootfs   → alpine-rootfs.manifest.json（bytes/sha256/nodejs/alpine/builtAt 四件套全变）",
  "              + .ready 三行格式不变（sha / 实测字节 / ts）→ 首启会重新解包",
  "换 proot    → PROOT_PIN（本脚本）+ jniLibs 三个 .so + tools/proot/README.md",
  "换客户端    → versionCode 单调递增；release key 永久固定（signing/dsh-release.jks）",
  "```",
  "",
];

const text = lines.join("\n");
const mode = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--stdout")
    ? "stdout"
    : "write";

if (mode === "stdout") {
  process.stdout.write(text);
} else if (mode === "check") {
  if (!existsSync(OUT)) {
    console.error(`✗ 缺 ${OUT}，请先跑 node tools/gen-version-matrix.mjs`);
    process.exit(1);
  }
  const cur = readFileSync(OUT, "utf8");
  if (cur !== text) {
    console.error("✗ version-matrix.md 与源码不一致（有人手改或版本变了没重生成）");
    console.error("  修法：node tools/gen-version-matrix.mjs");
    process.exit(1);
  }
  console.log("✓ version-matrix.md 与源码一致");
} else {
  writeFileSync(OUT, text, "utf8");
  console.log(`✓ 写入 ${OUT}（${text.length} B）`);
  console.log(`  APK ${versionName} (code ${versionCode})｜rootfs alpine ${manifest.alpine} / node ${manifest.nodejs}`);
}