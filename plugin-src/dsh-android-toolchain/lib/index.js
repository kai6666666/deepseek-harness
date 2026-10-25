/**
 * dsh-android-toolchain — host 半
 *
 * 提供两件事：
 *   1. HTTP 接口 /dsh-android-toolchain/api/{state,install}，供 client 半与外部脚本调用
 *   2. 若当前引擎暴露了 ctx.tools，则额外注册两个模型工具：
 *        android_toolchain        —— 查看/安装某一组环境依赖
 *        android_native_precheck  —— 判定某个 npm 包能否在本机跑起来
 *
 * 设计约束（照 DSH 插件开发指南 §5.3）：
 *   - apply() 里任何异常都必须吞掉，否则会拖垮引擎启动
 *   - 所有注册都包在 ctx.effect() 里，卸载时自动清理
 *   - 不写死路径，状态落在 $DSH_HOME 下
 */
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * provision.json 缺失或损坏时不能让模块顶层抛异常 —— 那会让整个插件加载失败，
 * 在 DSH 里表现为「引擎判定插件注册失败」。这里降级成空表，apply() 里再报。
 */
let PROVISION = {
  backends: {
    termux: { detect: { env: "PREFIX", match: "files/usr" }, query: ["sh", "-c", "command -v {bin}"], install: ["pkg", "install", "-y", "{pkgs}"] },
  },
  groups: {},
  nativeSignals: { packages: [], wasmAlternatives: {}, neverPortable: [] },
};
let PROVISION_ERROR = null;
try {
  PROVISION = JSON.parse(readFileSync(join(HERE, "..", "provision.json"), "utf8"));
} catch (error) {
  PROVISION_ERROR = String(error?.message ?? error);
  console.error("[dsh-android-toolchain] provision.json 读取失败，降级为空表:", PROVISION_ERROR);
}
const ROUTE = "/dsh-android-toolchain/api";
const STATE_FILE = join(homedir(), ".dsh", "android-toolchain.json");

/** 一次只跑一个安装任务；重复请求直接返回 busy。 */
let installing = null;

/* ─────────────────────────── 后端探测 ─────────────────────────── */

function readOsRelease() {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return "";
  }
}

function detectBackend() {
  const osRelease = readOsRelease();
  for (const [name, backend] of Object.entries(PROVISION.backends)) {
    const { detect } = backend;
    if (detect.file && detect.file === "/etc/os-release") {
      if (new RegExp(detect.match, "m").test(osRelease)) return name;
    }
    if (detect.env && detect.match) {
      const value = process.env[detect.env] ?? "";
      if (new RegExp(detect.match).test(value)) return name;
    }
  }
  // 兜底：按 process.platform 给一个「最可能」的后端名，仅用于展示
  return process.platform === "android" ? "termux" : "linux-glibc";
}

function backendSpec(name) {
  return PROVISION.backends[name] ?? PROVISION.backends.termux;
}

/* ─────────────────────────── 依赖检测 ─────────────────────────── */

/* ── G-13：杀整个进程组 ────────────────────────────────────────────────
 * proot 只是壳，真正干活的是它拉起的 node。只 child.kill() 会留孤儿：
 * 超时/取消之后端口照样被占着，下次启动撞 EADDRINUSE。
 * spawn 时 detached:true 让子进程成为新进程组的 leader，这里用 kill(-pid)
 * 一次收掉整组，最后再 child.kill 兜底（组已不存在时）。
 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (e) {
    if (e && e.code !== "ESRCH") {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

function runSync(argv, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let out = "",
      err = "";
    let done = false;
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: true,
    });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        killTree(child);
        resolve({ code: 124, stdout: out, stderr: err });
      }
    }, timeoutMs);
    child.stdout?.on("data", (b) => (out += b.toString()));
    child.stderr?.on("data", (b) => (err += b.toString()));
    child.on("error", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code: 127, stdout: out, stderr: err });
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout: out, stderr: err });
      }
    });
  });
}

function expand(template, values) {
  const list = [];
  for (const token of template) {
    if (token === "{pkgs}") list.push(...values.pkgs);
    else list.push(token.replace("{pkg}", values.pkgs[0] ?? "").replace("{bin}", values.bins?.[0] ?? ""));
  }
  return list;
}

async function probeGroup(key, backendName) {
  const group = PROVISION.groups[key];
  const spec = group?.[backendName];
  if (!group || !spec) return { key, installed: false, missing: ["(backend unsupported)"], bins: [] };

  const backend = backendSpec(backendName);
  // alpine / linux-glibc 按「包名」查（apk info -e openssh / dpkg -s openssh-client）
  // termux 没有包库查询，只能按「二进制」查（command -v ssh）
  const pkgQuery = backendName === "alpine" || backendName === "linux-glibc";
  const targets = pkgQuery ? (spec.pkgs ?? []) : (spec.bins ?? []);
  if (!targets.length) {
    return { key, label: group.label, tier: group.tier, installed: false, missing: ["(no probe target)"], bins: [] };
  }

  const results = [];
  for (const target of targets) {
    const argv = pkgQuery
      ? expand(backend.query, { pkgs: [target] })
      : expand(backend.query, { pkgs: [target], bins: [target] });
    const r = await runSync(argv);
    results.push({ target, ok: r.code === 0 });
  }
  const missing = results.filter((r) => !r.ok).map((r) => r.target);
  return {
    key,
    label: group.label,
    tier: group.tier,
    locked: !!group.locked,
    defaultOn: !!group.default,
    sizeMB: group.sizeMB,
    reason: group.reason,
    installed: missing.length === 0,
    missing,
    bins: spec.bins ?? [],
    // 锁定的组只展示，不提供安装（Node 由 App 内置）
    installable: !group.locked,
  };
}

async function collectState() {
  const backend = detectBackend();
  const groups = [];
  for (const key of Object.keys(PROVISION.groups)) {
    try {
      groups.push(await probeGroup(key, backend));
    } catch (error) {
      groups.push({ key, installed: false, error: String(error?.message ?? error) });
    }
  }
  return {
    backend,
    platform: `${process.platform}-${process.arch}`,
    libc: detectLibc(),
    groups,
    busy: installing !== null,
    stateFile: STATE_FILE,
  };
}

function detectLibc() {
  try {
    const report = process.report.getReport();
    return report.header?.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return "unknown";
  }
}

/* ─────────────────────────── 安装 ─────────────────────────── */

function installGroups(keys) {
  if (installing) return Promise.resolve({ ok: false, busy: true, log: "已有安装任务在进行" });

  const backendName = detectBackend();
  const backend = backendSpec(backendName);
  const selected = keys.filter((k) => PROVISION.groups[k] && !PROVISION.groups[k].locked);
  if (!selected.length) return Promise.resolve({ ok: false, log: "没有可安装的分组" });

  const pkgs = new Set();
  for (const key of selected) {
    const spec = PROVISION.groups[key][backendName];
    for (const pkg of spec?.pkgs ?? []) pkgs.add(pkg);
  }
  const argv = expand(backend.install, { pkgs: [...pkgs] });

  installing = { groups: selected, argv, startedAt: Date.now() };

  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
      detached: true,
    });
    const timer = setTimeout(() => killTree(child), 600_000);

    const cap = (chunk, bucket) => {
      const text = chunk.toString();
      return (bucket + text).slice(-16384);
    };
    child.stdout?.on("data", (b) => (out = cap(b, out)));
    child.stderr?.on("data", (b) => (err = cap(b, err)));

    const finish = (code, extra = "") => {
      clearTimeout(timer);
      const result = {
        ok: code === 0,
        backend: backendName,
        groups: selected,
        argv,
        code,
        log: (out + "\n" + err + extra).trim(),
      };
      installing = null;
      resolve(result);
    };

    child.on("error", (e) => finish(127, String(e?.message ?? e)));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/* ─────────────────────────── 原生插件判定 ─────────────────────────── */

function hasBuildChain() {
  try {
    const r = spawnSync(
      "sh",
      [
        "-c",
        "command -v cc >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1",
      ],
      { timeout: 2000, stdio: "ignore" },
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

function precheck(pkgName, deps = []) {
  const signals = PROVISION.nativeSignals;
  const nativeRx = signals.packages.map((p) => new RegExp(p));
  const all = [pkgName, ...deps];
  const hits = all.filter((name) => nativeRx.some((rx) => rx.test(name)));
  const never = all.filter((name) =>
    signals.neverPortable.some((bad) => name.toLowerCase().includes(bad)),
  );

  const hasBuild = hasBuildChain();

  const alternatives = {};
  for (const hit of hits) {
    const key = Object.keys(signals.wasmAlternatives).find((k) => hit.startsWith(k));
    if (key) alternatives[hit] = signals.wasmAlternatives[key];
  }

  return {
    platform: `${process.platform}-${process.arch}`,
    libc: detectLibc(),
    needsNative: hits.length > 0,
    nativeHits: hits,
    buildChain: hasBuild,
    neverPortable: never,
    wasmAlternatives: alternatives,
    hint: never.length
      ? "该依赖需要内核能力，任何 Android 方案都跑不了；走远端 workspace。"
      : !hits.length
        ? "纯 JS，可直接安装。"
        : Object.keys(alternatives).length
          ? "可用 wasm 替代；若坚持原生，需要编译链 + N-API 8。"
          : hasBuild
            ? "需要 android 原生产物；本机已有编译链，可 node-gyp rebuild --napi_version=8。"
            : "需要 android 原生产物，但本机缺编译链；先装「插件编译链」分组（250 MB）。",
  };
}

/* ─────────────────────────── 插件入口 ─────────────────────────── */

/** 只依赖 webServer；tools 是可选的，缺了不报错。 */
export const inject = ["webServer"];

export function apply(ctx) {
  try {
    ctx.effect(() =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE}/state`,
        handler: async (req, res) => {
          try {
            const state = await collectState();
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(state));
          } catch (error) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(error?.message ?? error) }));
          }
        },
      }),
    );

    ctx.effect(() =>
      ctx.webServer.register({
        kind: "exact",
        path: `${ROUTE}/install`,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }
          let body = "";
          for await (const chunk of req) body += chunk;
          if (body.length > 8192) {
            res.writeHead(413).end();
            return;
          }
          let groups = [];
          try {
            groups = JSON.parse(body || "{}").groups ?? [];
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (!Array.isArray(groups) || groups.some((g) => typeof g !== "string")) {
            res.writeHead(400).end();
            return;
          }
          const result = await installGroups(groups);
          res.writeHead(result.ok ? 200 : 409, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify(result));
        },
      }),
    );

    // 工具注册是可选的：不同引擎版本 API 可能不同，失败只降级为「只能走 HTTP」。
    try {
      if (typeof ctx.tools?.register === "function") {
        ctx.effect(() =>
          ctx.tools.register({
            name: "android_toolchain",
            description:
              "查看或安装 Android 侧环境依赖（ssh / python / build / rust / java / go）。装原生插件前先跑一次。",
            parameters: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["state", "install"] },
                groups: { type: "array", items: { type: "string" } },
              },
              required: ["action"],
            },
            execute: async (args) => {
              if (args?.action === "install") {
                return installGroups(args.groups ?? []);
              }
              return collectState();
            },
          }),
        );

        ctx.effect(() =>
          ctx.tools.register({
            name: "android_native_precheck",
            description:
              "判定某个 npm 包（及其原生依赖）能否在当前 Android 环境安装并运行，给出 wasm 替代与远端建议。",
            parameters: {
              type: "object",
              properties: {
                pkg: { type: "string" },
                deps: { type: "array", items: { type: "string" } },
              },
              required: ["pkg"],
            },
            execute: async (args) => precheck(String(args?.pkg ?? ""), args?.deps ?? []),
          }),
        );
      }
    } catch (error) {
      console.error("[dsh-android-toolchain] 工具注册失败，已跳过（HTTP 接口仍可用）:", error);
    }
  } catch (error) {
    // 绝不让插件注册失败拖垮引擎
    console.error("[dsh-android-toolchain] 注册失败，已跳过:", error);
  }
}