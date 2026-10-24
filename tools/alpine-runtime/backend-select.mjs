#!/usr/bin/env node
/**
 * backend-select.mjs —— 双档切换开关（Alpine 默认 / Termux 性能档）
 *
 * 状态文件：$DSH_HOME/backend.json
 *   { "backend": "alpine", "updatedAt": "...", "history": [{"backend":"termux","at":"..."}] }
 *
 * CLI：
 *   node backend-select.mjs state            # 当前档 + 两档可用性
 *   node backend-select.mjs doctor           # 逐项检查依赖，缺失项给出修复命令
 *   node backend-select.mjs switch alpine    # 切换（写 state，不动任何二进制）
 *   node backend-select.mjs resolve          # 输出可 eval 的 shell 变量
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const STATE = join(HOME, "backend.json");
const ROOTFS = process.env.DSH_ALPINE_ROOTFS ?? join(HOME, "alpine");
const PROOT = process.env.DSH_PROOT ?? join(HOME, "bin/libproot.so");
const LOADER = process.env.DSH_PROOT_LOADER ?? join(HOME, "bin/proot-loader.so");
const WORKSPACE = process.env.DSH_WORKSPACE ?? join(homedir(), "workspace");
const TERMUX_NODE =
  process.env.DSH_TERMUX_NODE ?? (process.env.PREFIX ? join(process.env.PREFIX, "bin/node") : "");

const ok = (label, detail = "") => ({ label, ok: true, detail });
const bad = (label, detail = "") => ({ label, ok: false, detail });

function isExec(p) {
  try {
    const st = statSync(p);
    // 设备上是 proot/exec 位；Linux host 侧同样适用
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function probeAlpine() {
  const checks = [
    ok("rootfs", ROOTFS),
    isExec(join(ROOTFS, "usr/bin/node")) ? ok("rootfs node", join(ROOTFS, "usr/bin/node")) : bad("rootfs node", "缺 /usr/bin/node"),
    isExec(PROOT) ? ok("proot", PROOT) : bad("proot", `缺 ${PROOT}（或改 DSH_PROOT）`),
    existsSync(LOADER) ? ok("proot-loader", LOADER) : bad("proot-loader", `缺 ${LOADER}`),
  ];
  return { name: "alpine", available: checks.every((c) => c.ok), checks };
}

function probeTermux() {
  const checks = [
    TERMUX_NODE ? (isExec(TERMUX_NODE) ? ok("termux node", TERMUX_NODE) : bad("termux node", `缺 ${TERMUX_NODE}`))
                 : bad("termux node", "未设 PREFIX / DSH_TERMUX_NODE"),
    process.platform === "android"
      ? ok("platform", "android")
      : bad("platform", `当前 ${process.platform}（只是提示，设备上才是 android）`),
  ];
  // platform 不作为硬判据：host 上做预演也要能看结果
  const hard = checks.filter((c) => c.label === "termux node");
  return { name: "termux", available: hard.every((c) => c.ok), checks };
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { backend: null, history: [] };
  }
}

function writeState(next) {
  const prev = readState();
  const payload = {
    schema: 1,
    backend: next,
    updatedAt: new Date().toISOString(),
    history: [...(prev.history ?? []), ...(prev.backend ? [{ backend: prev.backend, at: prev.updatedAt }] : [])].slice(-10),
  };
  mkdirSync(dirname(STATE), { recursive: true });
  // 原子写：设备掉电时不会留下半个 JSON
  const tmp = STATE + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tmp, STATE);
  return payload;
}

/** 未设置时的默认档：能 alpine 就 alpine（生态优先），否则 termux。 */
function effectiveBackend(state, alpine, termux) {
  if (state.backend === "alpine" || state.backend === "termux") return state.backend;
  if (alpine.available) return "alpine";
  if (termux.available) return "termux";
  return null;
}

const argv = process.argv.slice(2);
const [cmd, arg] = argv;
const state = readState();
const alpine = probeAlpine();
const termux = probeTermux();

function printProbe(p) {
  console.log(`  ${p.available ? "✅" : "❌"} ${p.name.padEnd(7)} available=${p.available}`);
  for (const c of p.checks) {
    console.log(`      ${c.ok ? "·" : "!"} ${c.label.padEnd(14)} ${c.detail}`);
  }
}

switch (cmd) {
  case "state": {
    const eff = effectiveBackend(state, alpine, termux);
    console.log(`DSH_HOME   : ${HOME}`);
    console.log(`state file : ${STATE}${existsSync(STATE) ? "" : "（尚未创建）"}`);
    console.log(`saved      : ${state.backend ?? "(未设置)"}   effective: ${eff ?? "(无可用档)"}`);
    console.log(`updatedAt  : ${state.updatedAt ?? "-"}`);
    console.log("");
    printProbe(alpine);
    printProbe(termux);
    break;
  }

  case "doctor": {
    const eff = effectiveBackend(state, alpine, termux);
    printProbe(alpine);
    printProbe(termux);
    console.log(`\nworkspace  : ${WORKSPACE}${existsSync(WORKSPACE) ? "" : "（不存在，Alpine 档会退到 /root）"}`);
    console.log(`effective  : ${eff ?? "无"}`);
    if (!alpine.available) {
      console.log("\n修复 Alpine 档：");
      console.log("  bash tools/alpine-runtime/build-rootfs.sh      # 产出 rootfs.tar.gz");
      console.log(`  mkdir -p ${HOME}/bin && cp <proot> ${PROOT} && cp <proot-loader> ${LOADER}`);
      console.log(`  tar -xzf alpine-rootfs.tar.gz -C ${ROOTFS}`);
    } else {
      console.log("\nAlpine 档依赖齐全，可以跑 verify-rootfs.sh 做启动验收。");
    }
    process.exit(alpine.available || termux.available ? 0 : 1);
  }

  case "switch": {
    // ★ G-01 单档收口：termux 不再是「可切换的运行档」，只保留为工具链模式。
    //   理由（ADR-1）：两套 engine 的 .node ABI 互斥，切过去必然污染。
    //   要装东西用它没关系（dsh-runtime.sh doctor / tc-run.sh），别拿它跑引擎。
    if (arg === "termux") {
      console.error("✗ termux 已不再是运行档（单档收口，见 docs/RUNTIME-ARCH-PLAN.md ADR-1）");
      console.error("  它只作为「工具链模式」存在：装依赖可以，不承载引擎。");
      console.error("  要跑引擎：node backend-select.mjs switch alpine");
      process.exit(2);
    }
    if (arg !== "alpine") {
      console.error("用法: backend-select.mjs switch alpine");
      process.exit(2);
    }
    const target = alpine;
    if (!target.available && process.env.DSH_ALLOW_UNAVAILABLE !== "1") {
      console.error(`✗ ${arg} 档当前不可用（缺依赖）。加 DSH_ALLOW_UNAVAILABLE=1 可强制写入。`);
      printProbe(target);
      process.exit(1);
    }
    const payload = writeState(arg);
    console.log(`✓ 已切到 ${arg}`);
    console.log(JSON.stringify(payload, null, 2));
    break;
  }

  case "resolve": {
    const eff = effectiveBackend(state, alpine, termux) ?? "termux";
    console.log(`export DSH_BACKEND="${eff}"`);
    console.log(`export DSH_HOME="${HOME}"`);
    console.log(`export DSH_ALPINE_ROOTFS="${ROOTFS}"`);
    console.log(`export DSH_PROOT="${PROOT}"`);
    console.log(`export DSH_PROOT_LOADER="${LOADER}"`);
    console.log(`export DSH_WORKSPACE="${WORKSPACE}"`);
    break;
  }

  default:
    console.log("用法: node backend-select.mjs <state|doctor|switch <alpine|termux>|resolve>");
    process.exit(2);
}