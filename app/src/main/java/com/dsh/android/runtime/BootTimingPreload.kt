package com.dsh.android.runtime

import com.dsh.android.log.DshLog
import java.io.File

/**
 * B 阶段启动分段：guest 侧时间戳 wrapper（第 1 层 + 第 2 层 ESM 打点）。
 *
 * ## 第 1 层（CJS wrapper）
 *
 * ```text
 * PRoot 装载 = node.start.epoch - host.epoch     宿主 spawn 前写 boot-timing.host.json
 * node 引导  = preload          - node.start     process.uptime() 反推
 * 首响应    = first             - entry.end     拦 stdout/stderr 的 token 行
 * ```
 *
 * ## 第 2 层（ESM loader hook）
 *
 * `@deepseek-ai/dsh` 的 package.json 是 `"type": "module"`，`lib/bin.js` 是 **ESM**，
 * 不经过 `Module.prototype._compile` —— 真机实测 `epoch.entry.*` 恒为 na，而
 * `listen → listening` 之间稳定卡 13.4 s（三次 14,428 / 13,387 / 13,451 ms）。
 * 所以再挂一层 `--import`，用 `module.register()` 的 `resolve`/`load` 钩子把每个
 * ESM 模块的「时刻 + 耗时」写进 `boot-timing-esm.log`，并按相邻时间差反推求值段。
 *
 * 同时开 `--cpu-prof`（值 1 ms）落到 `$DSH_HOME/cpuprof/`：13.4 s 到底是 loader
 * 还是 V8 编译，只有 function 级 self-time 能一锤定音。
 *
 * ## 注入方式（不动任何既有形参）
 *
 * `NODE_OPTIONS` = 模板里原有的 `--dns-result-order=ipv4first`
 *               + `--require <cjs>` + `--import file://<esm>` + `--cpu-prof*`
 * 注入点在 `{GUEST_ENV}`（`env -i` 尾部，后者覆盖前者）。
 * manifest 的 launch.argv 里 node 与入口之间还隔着 /usr/local/bin/dsh 包脚本，
 * 且 manifest 是构建产物，所以 argv 改不动也不该改 —— 详见 progress §4.18.2。
 *
 * 失败一律返回 null / 静默：观测绝不阻塞启动。
 */
internal object BootTimingPreload {

    /** 第 1 层：CJS 预加载（`--require`）。 */
    const val GUEST_PATH: String = "/opt/dsh/.dsh-boot-timing.cjs"

    /** 第 2 层：ESM 预加载（`--import`），只负责 register。 */
    const val GUEST_ESM_PATH: String = "/opt/dsh/.dsh-boot-timing.esm.mjs"

    /** 第 2 层：loader hooks（在独立线程里跑 resolve/load）。 */
    const val GUEST_HOOKS_PATH: String = "/opt/dsh/.dsh-boot-timing-hooks.mjs"

    /** 宿主写进 `$DSH_HOME` 的 spawn 时间戳，guest 侧读同名文件对齐时间轴。 */
    const val HOST_STAMP: String = "boot-timing.host.json"

    /** `--cpu-prof` 的输出目录（相对 `$DSH_HOME`）。 */
    const val HOST_PROFILE_DIR: String = "cpuprof"

    /** V8 compile cache目录（相对 `$DSH_HOME`）；node ≥22.1 的 `module.enableCompileCache()` 写入。 */
    const val V8_CACHE_DIR: String = "v8cache"

    /** 缓存目录上限：超过就清空重建（node 会按需重写），避免无界增长。 */
    const val V8_CACHE_MAX_BYTES: Long = 128L * 1024 * 1024

    private const val TAG = "BootTiming"

    /** 诊断开关：`files/boot-trace.enable` 存在时，才注入 `--import` 与 `--cpu-prof`。
     *
     * 真机实测：常开这两项会把冷启从 42 s 拉到 71 s（+29 s）。所以默认关，
     * 需要采样时用 `run-as com.dsh.android touch files/boot-trace.enable` 打开，重启即生效。
 */
    const val TRACE_FLAG: String = "boot-trace.enable"

    /** 诊断开关是否打开。 */
    fun traceEnabled(filesDir: File): Boolean = File(filesDir, TRACE_FLAG).isFile

    /**
     * 写三个 guest 脚本 + 宿主时间戳 + 建 cpuprof 目录，返回要注入的 (KEY, VALUE)。
     *
     * 任何一步关键失败都返回 null —— 观测失败绝不能让启动失败。
     */
    fun guestEnv(
        rootfs: File,
        dshHome: File,
        template: List<String>,
        profile: String = "web",
        now: Long = System.currentTimeMillis(),
        trace: Boolean = false,
    ): Pair<String, String>? {
        if (!writeGuestFile(rootfs, GUEST_PATH, SCRIPT_CJS)) return null
        writeHostStamp(dshHome, profile, now)
        ensureV8Cache(dshHome)
        val value: String? = if (trace) {
            if (!writeGuestFile(rootfs, GUEST_ESM_PATH, SCRIPT_ESM)) return null
            if (!writeGuestFile(rootfs, GUEST_HOOKS_PATH, SCRIPT_HOOKS)) return null
            runCatching { File(dshHome, HOST_PROFILE_DIR).mkdirs() }
            nodeOptions(template, GUEST_PATH, GUEST_ESM_PATH, dshHome.canonicalPath, true)
        } else {
            nodeOptions(template, GUEST_PATH, GUEST_ESM_PATH, dshHome.canonicalPath, false)
        }
        if (value == null) return null
        return "NODE_OPTIONS" to value
    }

    /**
     * 把观测参数并进模板里已有的 `NODE_OPTIONS=...`。
     *
     * 模板里那条是 `--dns-result-order=ipv4first`，丢掉会改变 DNS 行为，
     * 所以合并而不是覆盖；且**幂等**：同样的参数已在内时不再重复追加。
     */
    fun nodeOptions(
        template: List<String>,
        cjsPath: String,
        esmPath: String,
        dshHomeGuest: String = "",
        trace: Boolean = false,
    ): String? {
        if (cjsPath.isBlank()) return null
        val wanted = ArrayList<String>()
        wanted += "--require " + cjsPath
        if (trace && esmPath.isNotBlank()) wanted += "--import file://" + esmPath
        if (trace && dshHomeGuest.isNotBlank()) {
            wanted += "--cpu-prof"
            wanted += "--cpu-prof-dir=" + dshHomeGuest + "/" + HOST_PROFILE_DIR
            wanted += "--cpu-prof-interval=1000"
        }
        val existing = template.firstOrNull { it.startsWith("NODE_OPTIONS=") }
            ?.removePrefix("NODE_OPTIONS=")
            ?.trim()
            .orEmpty()
        val missing = wanted.filterNot { existing.contains(it) }
        if (missing.isEmpty()) return existing
        return if (existing.isEmpty()) missing.joinToString(" ") else existing + " " + missing.joinToString(" ")
    }

    /**
     * 建 `v8cache` 目录并做体积自检：超过阈值就清空重建。返回当前字节数。
     *
     * 为什么要清：缓存文件按模块内容哈希命名，模块一升级旧文件就没人认领，会无界增长。
     * 128 MB 对 6~7 MB 的稳态占用是十几倍余量，只有异常情况才会触发。
     */
    fun ensureV8Cache(dshHome: File): Long {
        val dir = File(dshHome, V8_CACHE_DIR)
        runCatching { dir.mkdirs() }
        val files = runCatching { dir.listFiles()?.filter { it.isFile } ?: emptyList() }.getOrDefault(emptyList())
        val bytes = files.sumOf { it.length() }
        if (bytes > V8_CACHE_MAX_BYTES) {
            files.forEach { runCatching { it.delete() } }
            return 0L
        }
        return bytes
    }

    private fun writeGuestFile(rootfs: File, guestPath: String, text: String): Boolean = runCatching {
        val file = File(rootfs, guestPath.trimStart('/'))
        file.parentFile?.mkdirs()
        if (!file.isFile || file.readText() != text) file.writeText(text)
        file.setReadable(true, false)
        true
    }.getOrElse {
        DshLog.w(TAG, "写入失败 " + guestPath + "：" + it.message)
        false
    }

    private fun writeHostStamp(dshHome: File, profile: String, now: Long) {
        runCatching {
            dshHome.mkdirs()
            val q = '"'
            File(dshHome, HOST_STAMP).writeText(
                "{" + q + "hostEpoch" + q + ":" + now + "," + q + "profile" + q + ":" + q + profile + q + "}" + "\n",
            )
            true
        }.getOrElse {
            DshLog.w(TAG, "host stamp 写入失败：" + it.message)
            false
        }
    }

    /** 第 1 层：CJS wrapper（分段打点 + /proc/self/io 采样）。 */
    internal val SCRIPT_CJS: String = """
/* DSH Android —— B 阶段第 1 层：guest 侧时间戳 wrapper（纯观测，不改引擎行为）。
 * 由 BootTimingPreload.kt 每次启动前幂等写入 rootfs，
 * 通过 NODE_OPTIONS=--require /opt/dsh/.dsh-boot-timing.cjs 预加载。
 * 所有 hook 均包 try/catch：观测代码宁可不说话，也不能影响引擎启动。
 *
 * 四段口径（与宿主 boot.timeline 对齐）：
 * PRoot装载 = node.start.epoch - host.epoch
 * node 引导 = preload - node.start
 * 模块解析 = entry.end - preload
 * 首响应 = first - entry.end
 */
'use strict';
(function () {
    var fs = require('fs');
    var path = require('path');
    var Module = require('module');

    var T_PRELOAD = Date.now();
    var ENTRY = String(process.argv[1] || '').replace(/\\/g, '/');
    var IS_ENGINE = ENTRY.endsWith('@deepseek-ai/dsh/lib/bin.js') || ENTRY.endsWith('/.dsh/lib/bin.js');
    var DSH_HOME = process.env.DSH_HOME || '';
    var DSH_FILES = process.env.DSH_FILES || '';
    var LOG_DIR = DSH_FILES ? path.join(DSH_FILES, 'logs') : (DSH_HOME || '/tmp');
    var LOG_FILE = path.join(LOG_DIR, 'boot-timing.log');

    function note(text) {
        try { process.stderr.write('[boot-timing] ' + text + '\n'); } catch (e) { }
    }
    if (!IS_ENGINE) {
        note('skip pid=' + process.pid + ' entry=' + ENTRY);
        return;
    }

    function uptimeMs() {
        try { return Math.round(process.uptime() * 1000); } catch (e) { return -1; }
    }
    function since(hr) {
        try { return Number((process.hrtime.bigint() - hr) / 1000000n); } catch (e) { return -1; }
    }
    function readHostEpoch() {
        if (!DSH_HOME) return null;
        try {
            var raw = fs.readFileSync(path.join(DSH_HOME, 'boot-timing.host.json'), 'utf8');
            var o = JSON.parse(raw);
            return typeof o.hostEpoch === 'number' ? o.hostEpoch : null;
        } catch (e) { return null; }
    }
    function readIo() {
        try {
            var txt = fs.readFileSync('/proc/self/io', 'utf8');
            var out = {};
            txt.split('\n').forEach(function (line) {
                var m = line.match(/^([a-z_]+):\s*(\d+)/);
                if (m) out[m[1]] = Number(m[2]);
            });
            return out;
        } catch (e) { return null; }
    }

    // V8 compile cache：只对引擎进程开。node >= 22.1 提供 module.enableCompileCache()。
    var CACHE_STATE = 'off';
    try {
        var mc = require('module');
        if (mc && typeof mc.enableCompileCache === 'function') {
            var cacheDir = process.env.DSH_V8CACHE || (DSH_HOME ? DSH_HOME + '/v8cache' : '');
            var st = cacheDir ? mc.enableCompileCache(cacheDir) : mc.enableCompileCache();
            var got = (typeof mc.getCompileCacheDir === 'function') ? mc.getCompileCacheDir() : '';
            CACHE_STATE = 'on dir=' + got + ' st=' + JSON.stringify(st);
        }
    } catch (e) {
        CACHE_STATE = 'fail ' + (e && e.message);
    }
    if (CACHE_STATE !== 'off') note('compile-cache ' + CACHE_STATE);

    var HOST_EPOCH = readHostEpoch();
    var UPTIME_MS = uptimeMs();
    var NODE_START = UPTIME_MS >= 0 ? T_PRELOAD - UPTIME_MS : null;
    var IO_PRELOAD = readIo();

    var modCount = 0;
    var modMs = 0;
    var modSlow = [];
    var entryStart = null;
    var entryHr = null;
    var entryEnd = null;
    var entryCompileMs = null;
    var cachedAtEntry = null;
    var first = null;
    var firstHr = null;
    var firstIo = null;
    var listenAt = null;
    var listeningAt = null;
    var flushed = false;

    function isEntryFile(fn) {
        return fn.endsWith('@deepseek-ai/dsh/lib/bin.js') || fn.endsWith('/.dsh/lib/bin.js');
    }

    var origCompile = Module.prototype._compile;
    Module.prototype._compile = function (content, filename) {
        var fn = String(filename || '');
        var mine = isEntryFile(fn);
        var hr = process.hrtime.bigint();
        if (mine && entryStart === null) {
            entryStart = Date.now();
            entryHr = process.hrtime.bigint();
        }
        try {
            return origCompile.call(this, content, filename);
        } finally {
            try {
                var d = since(hr);
                modCount += 1;
                modMs += d;
                if (modSlow.length < 400) modSlow.push([d, fn]);
                if (mine && entryEnd === null) {
                    entryEnd = Date.now();
                    entryCompileMs = d;
                    try { cachedAtEntry = Object.keys(require.cache).length; } catch (e) { }
                }
            } catch (e) { }
        }
    };

    var TOKEN_RE = /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/;
    function hookStream(stream) {
        if (!stream || typeof stream.write !== 'function') return;
        var orig = stream.write;
        stream.write = function (chunk) {
            try {
                if (first === null && chunk) {
                    var s = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '');
                    if (TOKEN_RE.test(s)) {
                        first = Date.now();
                        firstHr = process.hrtime.bigint();
                        firstIo = readIo();
                        flush('token');
                    }
                }
            } catch (e) { }
            return orig.apply(this, arguments);
        };
    }
    hookStream(process.stdout);
    hookStream(process.stderr);

    try {
        var net = require('net');
        var origListen = net.Server.prototype.listen;
        net.Server.prototype.listen = function () {
            if (listenAt === null) listenAt = Date.now();
            try {
                this.once('listening', function () { if (listeningAt === null) listeningAt = Date.now(); });
            } catch (e) { }
            return origListen.apply(this, arguments);
        };
    } catch (e) { }

    function topSlow() {
        var arr = modSlow.slice().sort(function (a, b) { return b[0] - a[0]; });
        return arr.slice(0, 12).map(function (x) { return x[0] + 'ms ' + x[1]; }).join(' | ');
    }
    function num(v) { return v === null ? 'na' : v; }

    function flush(reason) {
        if (flushed) return;
        flushed = true;
        try {
            var lines = [];
            lines.push('--- boot-timing v1 reason=' + reason + ' ---');
            lines.push('pid=' + process.pid + ' node=' + process.version + ' entry=' + ENTRY);
            lines.push('epoch.preload=' + T_PRELOAD);
            lines.push('host.epoch=' + num(HOST_EPOCH));
            lines.push('node.uptime.ms=' + UPTIME_MS);
            lines.push('node.start.epoch=' + num(NODE_START));
            if (HOST_EPOCH !== null && NODE_START !== null) lines.push('host.to.node.ms=' + (NODE_START - HOST_EPOCH));
            lines.push('epoch.entry.start=' + num(entryStart));
            lines.push('preload.to.entry.ms=' + (entryStart === null ? 'na' : entryStart - T_PRELOAD));
            lines.push('epoch.entry.end=' + num(entryEnd));
            lines.push('entry.compile.ms=' + num(entryCompileMs));
            lines.push('modules.cached=' + num(cachedAtEntry));
            lines.push('epoch.listen=' + num(listenAt));
            lines.push('epoch.listening=' + num(listeningAt));
            lines.push('epoch.first=' + num(first));
            if (entryEnd !== null && first !== null) lines.push('entry.to.first.ms=' + (first - entryEnd));
            if (first !== null) lines.push('preload.to.first.ms=' + (first - T_PRELOAD));
            if (first !== null) lines.push('first.cpu.ms=' + since(firstHr));
            lines.push('modules.count=' + modCount);
            lines.push('modules.compile.ms=' + modMs);
            lines.push('modules.avg.ms=' + (modCount ? (modMs / modCount).toFixed(2) : 'na'));
            lines.push('modules.top=' + topSlow());
            if (IO_PRELOAD) lines.push('io.preload=rchar:' + IO_PRELOAD.rchar + ' read_bytes:' + IO_PRELOAD.read_bytes + ' syscr:' + IO_PRELOAD.syscr);
            if (firstIo) lines.push('io.first=rchar:' + firstIo.rchar + ' read_bytes:' + firstIo.read_bytes + ' syscr:' + firstIo.syscr);
            lines.push('--- end ---');
            var blob = lines.join('\n') + '\n';
            try {
                fs.mkdirSync(LOG_DIR, { recursive: true });
                fs.appendFileSync(LOG_FILE, blob);
            } catch (e) {
                note('log write failed: ' + e.message);
            }
            lines.forEach(function (l) { note(l); });
        } catch (e) { }
    }

    process.on('exit', function () { flush('exit'); });
    try {
        process.on('uncaughtException', function (e) {
            try { note('uncaught: ' + (e && e.message ? e.message : String(e))); } catch (x) { }
            flush('uncaught');
        });
    } catch (e) { }

    note('armed pid=' + process.pid + ' uptime.ms=' + UPTIME_MS + ' host.epoch=' + num(HOST_EPOCH) + ' listenHook=1');
})();
"""

    /** 第 2 层：ESM 预加载，只做 `module.register()`；非引擎入口直接跳过。 */
    internal val SCRIPT_ESM: String = """
import { register } from 'node:module';
import path from 'node:path';

const entry = String(process.argv[1] || '').replace(/\\/g, '/');
const isEngine = entry.endsWith('@deepseek-ai/dsh/lib/bin.js');
if (!isEngine) {
  process.stderr.write('[boot-timing-esm] skip entry=' + entry + '\n');
} else {
  const base = process.env.DSH_FILES || process.env.DSH_HOME || '/tmp';
  const logFile = base.endsWith('/logs') ? path.join(base, 'boot-timing-esm.log') : path.join(base, 'logs', 'boot-timing-esm.log');
  try {
    register(new URL('./.dsh-boot-timing-hooks.mjs', import.meta.url).href, {
      parentURL: import.meta.url,
      data: { logFile, t0: Date.now() },
    });
    process.stderr.write('[boot-timing-esm] register ok log=' + logFile + '\n');
  } catch (e) {
    process.stderr.write('[boot-timing-esm] register failed: ' + (e && e.message) + '\n');
  }
}
"""

    /** 第 2 层：loader hooks。逐条 append（不攒批），保证进程被杀也不丢尾部。 */
    internal val SCRIPT_HOOKS: String = """
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

let LOG = '/tmp/boot-timing-esm.log';
let BUF = [];
let count = 0;

function flush() {
  if (!BUF.length) return;
  const blob = BUF.join('\n') + '\n';
  BUF = [];
  try { fs.appendFileSync(LOG, blob); } catch (e) { }
}

function record(kind, ms, url) {
  count += 1;
  BUF.push(kind + ' t=' + Date.now() + ' ms=' + ms.toFixed(2) + ' ' + url);
  flush();
}

export function initialize(data) {
  if (data && data.logFile) LOG = data.logFile;
  BUF.push('--- esm-timing v1 start=' + Date.now() + ' pid=' + process.pid + ' ---');
  flush();
  try { setInterval(flush, 250).unref(); process.on('exit', flush); } catch (e) { }
}

export async function resolve(specifier, context, nextResolve) {
  const t = performance.now();
  const r = await nextResolve(specifier, context);
  const ms = performance.now() - t;
  if (ms >= 0.5) record('resolve', ms, r.url || specifier);
  return r;
}

export async function load(url, context, nextLoad) {
  const t = performance.now();
  const r = await nextLoad(url, context);
  const ms = performance.now() - t;
  record('load', ms, url);
  return r;
}
"""
}
