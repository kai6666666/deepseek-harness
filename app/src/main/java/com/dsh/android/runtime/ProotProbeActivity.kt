package com.dsh.android.runtime

import android.app.Activity
import android.os.Bundle
import android.util.Log
import java.io.File

/**
 * P2 真机探针：不画界面，跑一遍「启动 → token → 401 → 停止 → 无孤儿」，
 * 结果写到 files/proot-probe.txt，供 adb/root shell 读取。
 *
 * 只在调试期用 `am start -n com.dsh.android/.runtime.ProotProbeActivity` 拉起；
 * 不导出、无 intent-filter。
 */
class ProotProbeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 模式一：一次性在 proot 内跑一个 node 脚本（设备侧验收用）
        //   am start -n com.dsh.android/.runtime.ProotProbeActivity \
        //     --es run_script /data/user/0/com.dsh.android/files/home/.dsh/x.mjs --es run_args "--tools"
        // 脚本必须放在 guest 可见路径（$DSH_HOME / workspace / /sdcard），不能放 /data/local/tmp。
        val script = intent?.getStringExtra("run_script")
        if (!script.isNullOrBlank()) {
            val a = intent?.getStringExtra("run_args") ?: ""
            Thread({ runScript(script, a) }, "proot-script").start()
            return
        }
        // 模式二：只有显式放了 marker 才跑：既能让 shell 拉起，又不会误触发
        if (!File(filesDir, "proot-probe.enable").isFile) {
            finish()
            return
        }
        Thread({ runProbe() }, "proot-probe").start()
    }

    /** 在 proot 内执行一次 node 脚本，stdout/exit 落 files/proot-probe.txt。 */
    private fun runScript(script: String, args: String) {
        val out = StringBuilder()
        fun line(s: String) {
            Log.i(TAG, s)
            out.append(s).append('\n')
        }
        var host: ProotHost? = null
        try {
            val manifest = RootfsInstaller(this).readManifestFromAssets()
            host = ProotHost(this, manifest)
            val argv = arrayListOf("/usr/local/bin/node", script)
            args.split(' ').filter { it.isNotBlank() }.forEach { argv.add(it) }
            line("run_script=" + script)
            line("run_args=" + args)
            val p = host.startCommand(argv)
            p.inputStream.bufferedReader().useLines { seq -> seq.forEach { line("out| " + it) } }
            line("exit=" + p.waitFor())
        } catch (t: Throwable) {
            line("EXCEPTION " + t.javaClass.simpleName + ": " + t.message)
            Log.e(TAG, "script failed", t)
        } finally {
            try {
                line("stopped=" + (host?.stop() ?: true))
            } catch (t: Throwable) {
                line("STOP_EXCEPTION " + t.message)
            }
            runCatching { File(filesDir, "proot-probe.txt").writeText(out.toString()) }
            finish()
        }
    }

    private fun runProbe() {
        val out = StringBuilder()
        fun line(s: String) {
            Log.i(TAG, s)
            out.append(s).append('\n')
        }
        var host: ProotHost? = null
        try {
            val installer = RootfsInstaller(this)
            val manifest = runCatching { installer.readManifestFromAssets() }
                .getOrElse { RuntimeManifest.load(this) }
            if (!installer.isInstalled(manifest)) {
                line("install=start " + manifest.runtimeVersion)
                installer.ensure(manifest) { line("install=" + it.phase + " " + it.done + "/" + it.total) }
                line("install=done")
            }
            host = ProotHost(this, manifest)

            line("runtimeVersion=" + manifest.runtimeVersion)
            line("rootfs=" + File(filesDir, "runtime/rootfs").absolutePath)
            val t0 = System.currentTimeMillis()
            host.start(emptyMap())
            line("started (+" + (System.currentTimeMillis() - t0) + "ms)")

            val token = host.awaitToken(180_000)
            if (token == null) {
                line("TOKEN_TIMEOUT")
                host.recentLines(30).forEach { line("web| " + it) }
            } else {
                line("tokenUrl=" + token)
                line("token_after_ms=" + (System.currentTimeMillis() - t0))
                Thread.sleep(2000)
                val code = host.health()
                line("http=" + code)
                line("health=" + if (code == manifest.unauthStatus) "PASS" else "FAIL")
            }
        } catch (t: Throwable) {
            line("EXCEPTION " + t.javaClass.simpleName + ": " + t.message)
            Log.e(TAG, "probe failed", t)
        } finally {
            try {
                val ok = host?.stop() ?: true
                line("stopped=" + ok)
                Thread.sleep(500)
                val leftovers = countLeftovers()
                line("leftover_node=" + leftovers)
                line("RESULT=" + if (out.contains("health=PASS") && leftovers == 0) "PASS" else "FAIL")
            } catch (t: Throwable) {
                line("STOP_EXCEPTION " + t.message)
            }
            runCatching {
                File(filesDir, "proot-probe.txt").writeText(out.toString())
            }
            finish()
        }
    }

    private fun countLeftovers(): Int {
        val marker = File(filesDir, "runtime/rootfs/usr/bin/node").absolutePath
        val proc = File("/proc")
        var n = 0
        proc.listFiles()?.forEach { p ->
            if (!p.name.all { it.isDigit() }) return@forEach
            val cmd = runCatching { File(p, "cmdline").readBytes() }.getOrNull() ?: return@forEach
            val s = String(cmd, Charsets.UTF_8).replace('\u0000', ' ')
            if (s.contains(marker) || s.contains("libproot.so")) n++
        }
        return n
    }

    companion object {
        const val TAG = "ProotProbe"
    }
}