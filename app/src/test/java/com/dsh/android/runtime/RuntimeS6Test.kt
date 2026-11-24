package com.dsh.android.runtime

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.nio.file.Files

class RuntimeS6Test {
    @get:Rule val tmp = TemporaryFolder()
    private fun file(root: File, name: String, text: String = name): File =
        File(root, name).apply { parentFile.mkdirs(); writeText(text) }
    private val template = listOf("{NATIVE_LIB_DIR}/libproot.so", "--kill-on-exit", "--rootfs={ROOTFS}",
        "/usr/bin/env", "-i", "NODE_PATH=/opt/dsh/node_modules", "{GUEST_ENV}", "/bin/sh", "-c",
        "echo \$\$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web {PATCHES} --host 127.0.0.1 --port {PORT} --no-open")

    @Test fun criticalEntryLossInvalidatesRuntime() {
        val root = tmp.newFolder()
        RuntimeFiles.criticalFiles.forEach { file(root, it) }
        assertTrue(RuntimeFiles.missingCriticalFiles(root).isEmpty())
        File(root, RuntimeFiles.criticalFiles.last()).delete()
        assertEquals(listOf(RuntimeFiles.criticalFiles.last()), RuntimeFiles.missingCriticalFiles(root))
    }
    @Test fun zeroLengthNodeInvalidatesRuntime() {
        val root = tmp.newFolder()
        RuntimeFiles.criticalFiles.forEach { file(root, it) }
        file(root, "usr/bin/node", "")
        assertEquals(listOf("usr/bin/node"), RuntimeFiles.missingCriticalFiles(root))
    }
    @Test fun spacePrecheckOnlyFailsWhenMeasuredAndShort() {
        val need = RuntimeFiles.ASSUME_UNPACKED_BYTES
        assertTrue(RuntimeFiles.insufficientSpace(need - 1, need))
        assertFalse(RuntimeFiles.insufficientSpace(need, need))
        assertFalse(RuntimeFiles.insufficientSpace(0, need))    // 读不到空间 ⇒ 放行
        assertFalse(RuntimeFiles.insufficientSpace(-1, need))
    }
    @Test fun builderStubResolverIsRejected() {
        val runner = "# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch us-west-2.compute.internal\n"
        assertTrue(RuntimeFiles.needsPublicDns(runner))
        assertTrue(RuntimeFiles.needsPublicDns(""))
        assertTrue(RuntimeFiles.needsPublicDns("nameserver 127.0.0.1\n"))
        assertTrue(RuntimeFiles.needsPublicDns("# only comments\n"))
        assertFalse(RuntimeFiles.needsPublicDns("nameserver 223.5.5.5\n"))
        assertFalse(RuntimeFiles.needsPublicDns("nameserver 9.9.9.9\nsearch lan\n"))
        assertTrue(RuntimeFiles.PUBLIC_DNS.contains("223.5.5.5"))
    }

    @Test fun pathBoundaryIsNotAStringPrefix() {
        val root = tmp.newFolder("data")
        assertTrue(RuntimeFiles.contains(root, File(root, "profiles/web")))
        assertFalse(RuntimeFiles.contains(root, File(root.parentFile, "data-other/file")))
        assertFalse(RuntimeFiles.contains(root, File(root, "../outside")))
    }
    @Test fun guestErrorsMapToTheInstalledEngine() {
        val root = tmp.newFolder()
        val home = File(root, "home/.dsh")
        assertEquals(File(root, "runtime/rootfs/opt/dsh/bad.yml"),
            RuntimeFiles.managedFile(File("/opt/dsh/bad.yml"), root, home))
        assertNull(RuntimeFiles.managedFile(File("/opt/dsh-other/bad.yml"), root, home))
        assertNull(RuntimeFiles.managedFile(File(root, "home/.dsh-other/secret"), root, home))
    }
    @Test fun treeCleanupLeavesSymlinkTargetsIntact() {
        val root = tmp.newFolder()
        val home = tmp.newFolder()
        val session = file(home, "sessions/keep.json", "keep")
        Files.createSymbolicLink(File(root, "user-data").toPath(), home.toPath())
        RuntimeFiles.deleteTree(root)
        assertEquals("keep", session.readText())
        assertFalse(root.exists())
    }
    @Test fun failedSwapRestoresPreviousTree() {
        val parent = tmp.newFolder()
        val root = File(parent, "rootfs").apply { mkdir() }
        file(root, "node", "old")
        try {
            RuntimeFiles.swapRootfs(root, File(parent, "missing-staging"))
            fail("swap should throw")
        } catch (_: IOException) { }
        assertEquals("old", File(root, "node").readText())
    }
    @Test fun successfulSwapPreservesNewSymlinksAndExternalData() {
        val parent = tmp.newFolder()
        val root = File(parent, "rootfs").apply { mkdir() }
        val stage = File(parent, "stage").apply { mkdir() }
        val data = file(parent, "data/keep", "user")
        Files.createSymbolicLink(File(root, "outside").toPath(), data.parentFile.toPath())
        file(stage, "node", "new")
        Files.createSymbolicLink(File(stage, "alias").toPath(), File("node").toPath())
        val old = RuntimeFiles.swapRootfs(root, stage)
        assertNotNull(old)
        RuntimeFiles.deleteTree(old!!)
        assertEquals("user", data.readText())
        assertTrue(Files.isSymbolicLink(File(root, "alias").toPath()))
        assertEquals("new", File(root, "alias").readText())
    }
    @Test fun legacyRetirementIsAnExactIdempotentAllowlist() {
        val root = tmp.newFolder()
        val protectedPaths = listOf("home/.dsh/sessions/a", "home/.dsh/.credentials.yaml", "workspace/a",
            "logs/a", "termux/home/custom", "home/.dsh/profiles/web/package.json")
        protectedPaths.forEach { file(root, it) }
        listOf("engine/a", "usr/a", "termux/usr/a").forEach { file(root, it) }
        assertEquals(listOf("engine", "usr", "termux"), RuntimeFiles.purgeLegacy(root))
        protectedPaths.forEach { assertEquals(it, File(root, it).readText()) }
        assertFalse(File(root, "usr").exists())
        assertFalse(File(root, "runtime/legacy-bionic").exists())
        assertTrue(RuntimeFiles.purgeLegacy(root).isEmpty())
    }
    @Test fun legacySymlinkIsMovedWithoutTraversingUserData() {
        val root = tmp.newFolder()
        val data = file(root, "home/.dsh/sessions/a", "still here")
        Files.createSymbolicLink(File(root, "usr").toPath(), data.parentFile.toPath())
        assertEquals(listOf("usr"), RuntimeFiles.purgeLegacy(root))
        assertEquals("still here", data.readText())
    }
    @Test fun rescueSharesWebEnvironmentAndQuotesPatches() {
        val result = ProotLaunch.template(template, "rescue", "/tmp/dsh-web.pid", "/tmp/probe-1.pid",
            listOf("/home/a b/patch's.yml"))
        assertEquals(template.dropLast(1), result.dropLast(1))
        assertTrue(result.last().contains("--profile 'rescue'"))
        assertTrue(result.last().contains("'/tmp/probe-1.pid'"))
        assertTrue(result.last().contains("--patch '/home/a b/patch'\"'\"'s.yml'"))
        assertFalse(result.last().contains("{PATCHES}"))
    }
    @Test fun rawCommandsKeepTheSameManifestPrefix() {
        val result = ProotLaunch.template(template, "web", "/tmp/dsh-web.pid", "/tmp/dump.pid",
            emptyList(), listOf("/usr/local/bin/node", "-e", "console.log('ok')"))
        assertEquals(template.dropLast(1), result.dropLast(1))
        assertTrue(result.last().contains("exec '/usr/local/bin/node' '-e'"))
        assertFalse(result.last().contains("--host"))
    }
    @Test(expected = IllegalArgumentException::class) fun missingPatchAnchorFailsExplicitly() {
        ProotLaunch.template(template.map { it.replace("{PATCHES}", "") }, "web", "/tmp/dsh-web.pid", "/tmp/x.pid", emptyList())
    }
    @Test(expected = IllegalArgumentException::class) fun profileIsANameNotShellInput() {
        ProotLaunch.template(template, "rescue; echo x", "/tmp/dsh-web.pid", "/tmp/x.pid", emptyList())
    }
    @Test fun callerEnvGoesToAFileNotArgv() {
        val lines = ProotLaunch.envFileLines(mapOf("AGNES_CREDENTIAL" to "sk-a b'c", "DSH_PRIV_RUNNER" to "/data/x y/r.mjs"))
        assertEquals(listOf("export AGNES_CREDENTIAL='sk-a b'\"'\"'c'", "export DSH_PRIV_RUNNER='/data/x y/r.mjs'"), lines)
        val result = ProotLaunch.template(template, "web", "/tmp/dsh-web.pid", "/tmp/x.pid", emptyList(),
            envFile = "/data/user/0/p/files/home/.dsh/.proot-env-1")
        assertTrue(result.last().startsWith(". '/data/user/0/p/files/home/.dsh/.proot-env-1'; "))
        assertFalse(result.any { it.contains("sk-a b'c") })
    }
    @Test(expected = IllegalArgumentException::class) fun envKeyCannotInjectCommands() {
        ProotLaunch.envFileLines(mapOf("A; rm -rf /" to "x"))
    }
    @Test(expected = IllegalArgumentException::class) fun envValueMustBeSingleLine() {
        ProotLaunch.envFileLines(mapOf("A" to "x\nexport B=1"))
    }
    @Test fun envFileLinesRoundTripThroughTheShell() {
        val raw = "v with 'quote' and \$HOME and ; semicolon"
        val p = ProcessBuilder("/bin/sh", "-c", "set -a; " + ProotLaunch.envFileLines(mapOf("K" to raw))[0] +
            "; set +a; printf %s \"\$K\"").start()
        assertEquals(raw, p.inputStream.bufferedReader().readText())
        assertEquals(0, p.waitFor())
    }
    @Test fun quoteRoundTripsMetacharactersThroughTheShell() {
        val raw = "a b'c\"d;\$(echo injected)\nlast"
        val p = ProcessBuilder("/bin/sh", "-c", "printf %s " + ProotLaunch.quote(raw)).start()
        assertEquals(raw, p.inputStream.bufferedReader().readText())
        assertEquals(0, p.waitFor())
    }

    // ---------- P0：首启失败分类 ----------

    @Test fun spaceShortageIsReportedWithExactMbAndAnAction() {
        val need = RuntimeFiles.ASSUME_UNPACKED_BYTES
        val free = 800L * 1024 * 1024
        val info = RuntimeFailure.classify(IOException("存储空间不足"), free, need)
        assertEquals(RuntimeFailure.Kind.INSUFFICIENT_SPACE, info.kind)
        assertEquals("space", info.code)
        assertTrue(info.message().contains("800 MB"))
        assertTrue(info.message().contains("还差约"))
        assertTrue(info.action.contains("重试"))
    }

    @Test fun measuredSpaceWinsEvenWhenMessageIsWrapped() {
        val need = RuntimeFiles.ASSUME_UNPACKED_BYTES
        val wrapped = IOException("解包失败：boom")
        assertEquals(RuntimeFailure.Kind.INSUFFICIENT_SPACE,
            RuntimeFailure.classify(wrapped, 100L, need).kind)
        // 读不到空间（-1 / 0）时不能猜成「不足」
        assertEquals(RuntimeFailure.Kind.UNKNOWN,
            RuntimeFailure.classify(wrapped, -1L, need).kind)
        assertEquals(RuntimeFailure.Kind.UNKNOWN,
            RuntimeFailure.classify(wrapped, 0L, need).kind)
    }

    @Test fun corruptPartialAndPermissionAreDistinguished() {
        assertEquals(RuntimeFailure.Kind.CORRUPT_ASSET,
            RuntimeFailure.classify(IOException("rootfs分片校验失败：part2 sha256=dead")).kind)
        assertEquals(RuntimeFailure.Kind.INCOMPLETE,
            RuntimeFailure.classify(IOException("rootfs critical files missing: usr/bin/node")).kind)
        assertEquals(RuntimeFailure.Kind.PERMISSION,
            RuntimeFailure.classify(SecurityException("EACCES")).kind)
        assertEquals(RuntimeFailure.Kind.PERMISSION,
            RuntimeFailure.classify(IOException("无法创建 staging：/data/x")).kind)
    }

    @Test fun preClassifiedFailureIsNotReclassified() {
        val original = RuntimeFailure.Info(
            kind = RuntimeFailure.Kind.CORRUPT_ASSET,
            code = "asset-corrupt",
            title = "t", detail = "d", action = "a",
        )
        val failure = RootfsInstaller.Failure(original)
        // 即使外部传了「空间不足」的实测值，也不该覆盖已分类的结果
        assertEquals(original, RuntimeFailure.classify(failure, 1L, RuntimeFiles.ASSUME_UNPACKED_BYTES))
        // 断言用 Info.message()，避免在测试里写 \n 转义（曾经被 shell 层吃掉变成真换行）
        assertEquals(original.message(), failure.message)
    }

    // ---------- P0：增量基线清理 ----------

    @Test fun prunePartsKeepsNewestBaselineOnly() {
        val root = tmp.newFolder()
        val parts = File(root, "runtime/parts").apply { mkdirs() }
        val old = File(parts, "r1-old").apply { mkdirs() }
        file(old, "part1", "o")
        val fresh = File(parts, "r1-new").apply { mkdirs() }
        file(fresh, "part1", "n")
        old.setLastModified(System.currentTimeMillis() - 60_000)
        fresh.setLastModified(System.currentTimeMillis())
        assertEquals(listOf("r1-old"), RuntimeFiles.pruneParts(parts, keep = 1))
        assertFalse(old.exists())
        assertTrue(File(fresh, "part1").isFile)
        // 幂等：再跑一次什么都不删
        assertTrue(RuntimeFiles.pruneParts(parts, keep = 1).isEmpty())
    }

    @Test fun prunePartsNeverFollowsSymlinkedVersionDirs() {
        val root = tmp.newFolder()
        val parts = File(root, "runtime/parts").apply { mkdirs() }
        val userData = file(root, "home/.dsh/sessions/a", "keep me").parentFile
        val real = File(parts, "r1-real").apply { mkdirs() }
        file(real, "part1", "x")
        real.setLastModified(System.currentTimeMillis() - 60_000)
        Files.createSymbolicLink(File(parts, "r1-link").toPath(), userData.toPath())
        val newer = File(parts, "r1-new").apply { mkdirs() }
        newer.setLastModified(System.currentTimeMillis())
        val removed = RuntimeFiles.pruneParts(parts, keep = 1)
        // 符号链接目录不被统计、更不会被删；真目录按 mtime 只留最新
        assertEquals(listOf("r1-real"), removed)
        assertEquals("keep me", File(userData, "a").readText())
        assertTrue(Files.isSymbolicLink(File(parts, "r1-link").toPath()))
    }

    @Test fun prunePartsToleratesMissingDirAndBadKeep() {
        val missing = File(tmp.newFolder(), "nope")
        assertTrue(RuntimeFiles.pruneParts(missing).isEmpty())
        val parts = File(tmp.newFolder(), "parts").apply { mkdirs() }
        try {
            RuntimeFiles.pruneParts(parts, keep = 0)
            fail("keep=0 应该被拒绝")
        } catch (_: IllegalArgumentException) { }
    }
}
