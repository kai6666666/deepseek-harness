/**
 * pathmap.mjs —— host ↔ guest 路径映射（Alpine 档）
 *
 * 规则（与 proot-launch.sh 的 -b 绑定表严格对应，改一处必须改两处）：
 *
 *   host                                   guest
 *   /storage/emulated/0                    /sdcard
 *   $DSH_HOME                              /dsh-home
 *   $DSH_WORKSPACE                         /workspace
 *   $DSH_ALPINE_ROOTFS/**                  /（rootfs 自身）
 *   其他 host 绝对路径                      原样返回（供 termux 档使用）
 *
 * CLI：
 *   node pathmap.mjs to-guest /storage/emulated/0/MT2/x.md
 *   node pathmap.mjs to-host  /workspace/x.md
 *   node pathmap.mjs table
 *   node pathmap.mjs self-test
 */
import { homedir } from "node:os";
import { join, normalize } from "node:path";

export function buildMap(env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), ".dsh");
  const workspace = env.DSH_WORKSPACE ?? join(homedir(), "workspace");
  const rootfs = env.DSH_ALPINE_ROOTFS ?? join(home, "alpine");
  return [
    { host: "/storage/emulated/0", guest: "/sdcard", kind: "sdcard" },
    { host: home, guest: "/dsh-home", kind: "dsh-home" },
    { host: workspace, guest: "/workspace", kind: "workspace" },
    { host: rootfs, guest: "/", kind: "rootfs" },
  ];
}

/** 最长前缀优先，避免 /dsh-home 被 / 抢走。 */
function pick(map, key, from, to) {
  const sorted = [...map].sort((a, b) => b[from].length - a[from].length);
  for (const entry of sorted) {
    const head = entry[from];
    if (key === head || key.startsWith(head.endsWith("/") ? head : head + "/")) {
      const rest = key.slice(head.length);
      const base = to === "guest" ? entry.guest : entry.host;
      const trimmed = base.length > 1 && base.endsWith("/") ? base.slice(0, -1) : base;
      // guest 的 rootfs 基址是 "/"，rest 又没有前导斜杠，必须自己补
      const suffix = rest ? (rest.startsWith("/") ? rest : "/" + rest) : "";
      return normalize(trimmed + suffix);
    }
  }
  return null;
}

export function toGuest(hostPath, env = process.env) {
  return pick(buildMap(env), normalize(hostPath), "host", "guest");
}

export function toHost(guestPath, env = process.env) {
  return pick(buildMap(env), normalize(guestPath), "guest", "host");
}

/* ─────────────────────────── CLI ─────────────────────────── */

const argv = process.argv.slice(2);
const [mode, arg] = argv;

function printTable() {
  console.log("kind        host                            guest");
  console.log("----------  ------------------------------  ------------------------");
  for (const e of buildMap()) {
    console.log(
      `${e.kind.padEnd(10)}  ${e.host.padEnd(30)}  ${e.guest}`,
    );
  }
}

function selfTest() {
  const env = {
    DSH_HOME: "/data/data/com.dsh.android/files/.dsh",
    DSH_WORKSPACE: "/storage/emulated/0/MT2/apks/deepseek harness",
    DSH_ALPINE_ROOTFS: "/data/data/com.dsh.android/files/.dsh/alpine",
  };
  const cases = [
    // [fn, input, expected]
    ["toGuest", "/storage/emulated/0/MT2/a.md", "/sdcard/MT2/a.md"],
    ["toGuest", "/data/data/com.dsh.android/files/.dsh/backend.json", "/dsh-home/backend.json"],
    ["toGuest", "/storage/emulated/0/MT2/apks/deepseek harness/x/y.ts", "/workspace/x/y.ts"],
    ["toGuest", "/data/data/com.dsh.android/files/.dsh/alpine/usr/bin/node", "/usr/bin/node"],
    ["toGuest", "/tmp/elsewhere.txt", null],
    ["toHost", "/sdcard/DCIM/a.jpg", "/storage/emulated/0/DCIM/a.jpg"],
    ["toHost", "/dsh-home/engine/x.js", "/data/data/com.dsh.android/files/.dsh/engine/x.js"],
    ["toHost", "/workspace/a/b.md", "/storage/emulated/0/MT2/apks/deepseek harness/a/b.md"],
    ["toHost", "/usr/bin/node", "/data/data/com.dsh.android/files/.dsh/alpine/usr/bin/node"],
  ];

  let failed = 0;
  for (const [fn, input, expected] of cases) {
    const got = fn === "toGuest" ? toGuest(input, env) : toHost(input, env);
    const ok = got === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${fn}(${input}) → ${got}${ok ? "" : `  期望 ${expected}`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  process.exit(failed ? 1 : 0);
}

switch (mode) {
  case "to-guest": {
    const out = toGuest(arg ?? "");
    if (!out) { console.error("无法映射（不在任何绑定表内）"); process.exit(1); }
    console.log(out);
    break;
  }
  case "to-host": {
    const out = toHost(arg ?? "");
    if (!out) { console.error("无法映射（不在任何绑定表内）"); process.exit(1); }
    console.log(out);
    break;
  }
  case "table":
    printTable();
    break;
  case "self-test":
    selfTest();
    break;
  default:
    console.log("用法: node pathmap.mjs <to-guest|to-host|table|self-test> [path]");
    process.exit(2);
}