package com.dsh.android.runtime

import com.dsh.android.log.DshLog
import java.io.File

/**
 * B 阶段第 1 层：guest 侧时间戳 wrapper。
 *
 * ## 它解决什么
 *
 * 宿主只看到 `preflight` → `prootSpawn` → `nodeExec` 三个点，中间 40~60 秒是黑盒。
 * 这个 wrapper 把黑盒拆成四段：
 *
 * ```text
 * PRoot 装载 = node.start.epoch  - host.epoch      （宿主写的时间戳 → node 进程诞生）
 * node 引导 = preload           - node.start      （process.uptime() 反推）
 * 模块解析 = entry.end          - preload         （bin.js 及其同步 require 链）
 * 首响应   = first              - entry.end       （打印 token 行）
 * ```
 *
 * ## 为什么是 NODE_OPTIONS 而不是往 argv 插 `-r`
 *
 * `manifest.json` 的 `launch.argv` 里 node 与入口之间还隔着一层 `/usr/local/bin/dsh`
 * 包脚本（`exec /usr/local/bin/node .../lib/bin.js "$@"`），而 manifest 是构建产物、
 * 不在仓库里；`ProotLaunch.template()` 的形参也不该为了观测而长出新参数。
 * `NODE_OPTIONS` 由 node 自己解析，`--require` 在其白名单内，正好是「node 与入口之间」。
 * 注入点选在 `{GUEST_ENV}`（在 `env -i` 的 `NODE_OPTIONS=...` 之后），后者覆盖前者。
 *
 * ## 时间基准
 *
 * guest 侧只用 `Date.now()`（HANDOFF §6.3：宿主机直接跑 `./usr/bin/date` 会 ENOENT），
 * 单调区间用 `process.hrtime.bigint()`。跨边界对齐靠宿主在 spawn 前写下的 `hostEpoch`。
 *
 * ## 落盘
 *
 * stderr 一行一份（`LogStore.engine` → `engine.log`），同时 append 到
 * `files/logs/boot-timing.log`（与 `app.log` 同目录，便于和 `boot.timeline` 对照）。
 */
internal object BootTimingPreload {

    /** guest 内的绝对路径（rootfs 根 = `/`）。 */
    const val GUEST_PATH: String = "/opt/dsh/.dsh-boot-timing.cjs"

    /** 宿主写进 `$DSH_HOME` 的 spawn 时间戳，guest 侧读同名文件对齐时间轴。 */
    const val HOST_STAMP: String = "boot-timing.host.json"

    private const val TAG = "BootTiming"

    /**
     * 写 guest 脚本 + 宿主时间戳，返回要注入环境的 (KEY, VALUE)。
     *
     * 任何一步失败都返回 null —— 观测失败绝不能让启动失败。
     */
    fun guestEnv(
        rootfs: File,
        dshHome: File,
        template: List<String>,
        profile: String = "web",
        now: Long = System.currentTimeMillis(),
    ): Pair<String, String>? {
        if (!writeScript(File(rootfs, GUEST_PATH.trimStart('/')))) return null
        writeHostStamp(dshHome, profile, now)
        val value = nodeOptions(template, GUEST_PATH) ?: return null
        return "NODE_OPTIONS" to value
    }

    /**
     * 把 `--require <guestPath>` 并进模板里已有的 `NODE_OPTIONS=...`。
     *
     * 模板里那条是 `--dns-result-order=ipv4first`，丢掉会改变 DNS 行为，
     * 所以这里合并而不是覆盖。幂等：路径已在内时不再重复追加。
     */
    fun nodeOptions(template: List<String>, guestPath: String): String? {
        if (guestPath.isBlank()) return null
        val requireArg = "--require " + guestPath
        val existing = template.firstOrNull { it.startsWith("NODE_OPTIONS=") }
            ?.removePrefix("NODE_OPTIONS=")
            ?.trim()
            .orEmpty()
        if (existing.contains(guestPath)) return existing
        return if (existing.isEmpty()) requireArg else existing + " " + requireArg
    }

    private fun writeScript(file: File): Boolean = runCatching {
        file.parentFile?.mkdirs()
        if (!file.isFile || file.readText() != SCRIPT) file.writeText(SCRIPT)
        file.setReadable(true, false)
        true
    }.getOrElse {
        DshLog.w(TAG, "preload 写入失败：" + it.message)
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

    /** guest 侧脚本全文。`.cjs` 是必须的：`NODE_OPTIONS` 的 `--require` 只吃 CommonJS。 */
    internal val SCRIPT: String = """
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
}
