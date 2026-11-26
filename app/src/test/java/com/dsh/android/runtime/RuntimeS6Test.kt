package com.dsh.android.runtime

import org.junit.Assert.*
import org.junit.Assume.assumeTrue
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
    /**
     * 建符号链接；文件系统不支持就跳过这个测试。
     *
     * CI 容器上 createSymbolicLink 可能抛 UnsupportedOperationException 或
     * FileSystemException（取决于挂载方式与权限）。断言「符号链接行为正确」
     * 的前提是环境能建出来，建不出来应该 skip，而不是判失败。
     */
    private fun symlink(link: java.io.File, target: java.io.File) {
        try {
            java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())
        } catch (e: UnsupportedOperationException) {
            assumeTrue("当前文件系统不支持符号链接：${'$'}{e.message}", false)
        } catch (e: IOException) {
            assumeTrue("创建符号链接失败：${'$'}{e.message}", false)
        } catch (e: SecurityException) {
            assumeTrue("无权创建符号链接：${'$'}{e.message}", false)
        }
    }

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
        symlink(File(root, "user-data"), home)
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
        symlink(File(root, "outside"), data.parentFile)
        file(stage, "node", "new")
        symlink(File(stage, "alias"), File("node"))
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
        symlink(File(root, "usr"), data.parentFile)
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
        symlink(File(parts, "r1-link"), userData)
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

    // ---------- Phase 0 / V1：pruneParts 必须忽略 `.staging-*` ----------

    @Test fun prunePartsIgnoresDotStagingDirs() {
        val root = tmp.newFolder()
        val parts = File(root, "runtime/parts").apply { mkdirs() }
        val now = System.currentTimeMillis()

        // 两个「真版本」：按 mtime，v-old 更旧
        val old = File(parts, "v-old").apply { mkdirs() }
        file(old, "part1", "o")
        old.setLastModified(now - 120_000)
        val fresh = File(parts, "v-new").apply { mkdirs() }
        file(fresh, "part1", "n")
        fresh.setLastModified(now - 60_000)

        // 一个「被杀留下的半成品」：mtime 最新（这正是它会挤掉真基线的原因）
        val staging = File(parts, ".staging-v-new-999").apply { mkdirs() }
        file(staging, "part1", "partial")
        staging.setLastModified(now)

        // keep=1 必须只删 v-old；`.staging-*` 既不能参与排序，也不能被 pruneParts 删
        //（它归 sweepStale 管 —— 那是"启动时清残留"的地方，判据是 pid）
        assertEquals(listOf("v-old"), RuntimeFiles.pruneParts(parts, keep = 1))
        assertFalse(old.exists())
        assertTrue(File(fresh, "part1").isFile)
        assertTrue(staging.isDirectory)
        assertEquals("partial", File(staging, "part1").readText())
    }

    // ---------- Phase 0 / V2：sweepStale 要清 parts/.staging-*，但不碰本进程 ----------

    @Test fun sweepStaleClearsForeignStagingAndKeepsOwnPid() {
        val runtime = tmp.newFolder()
        val now = System.currentTimeMillis()

        // ① 一级目录：解包/交换残留
        val rs = File(runtime, "rootfs.staging-abc").apply { mkdirs() }
        val ro = File(runtime, "rootfs.old-123").apply { mkdirs() }

        // ② parts 下的 apply 临时目录
        val parts = File(runtime, "parts").apply { mkdirs() }
        val mine = File(parts, ".staging-r1-4242").apply { mkdirs() }
        val foreign = File(parts, ".staging-r1-7777").apply { mkdirs() }
        val legacyOld = File(parts, ".staging-oldformat").apply { mkdirs() }
        legacyOld.setLastModified(now - 25L * 60 * 60 * 1000)   // 超过 24h 兜底
        val legacyFresh = File(parts, ".staging-r1-nopid").apply { mkdirs() }
        legacyFresh.setLastModified(now)                         // 未超 24h，保留
        val realBaseline = File(parts, "r1-arm64-v8a-dsh0.2.2").apply { mkdirs() }
        file(realBaseline, "part1", "keep")

        val removed = RuntimeFiles.sweepStale(runtime, currentPid = 4242)

        // 一级两条 + 别人的 staging + 超龄的 legacy
        // 用 set 比较：removed 的顺序取决于 listFiles() 的返回顺序，
        // 而那个顺序在不同文件系统/内核上不保证稳定（曾在 CI 上偶发红）。
        assertEquals(
            setOf("rootfs.staging-abc", "rootfs.old-123",
                "parts/.staging-r1-7777", "parts/.staging-oldformat"),
            removed.toSet(),
        )
        assertEquals("不该有重复项", removed.size, removed.toSet().size)
        // 本进程自己的 staging 不能删（可能正在写）
        assertTrue(mine.isDirectory)
        // 未超龄、pid 解析不出来的也不删（宁可留一天）
        assertTrue(legacyFresh.isDirectory)
        // 真基线永远不动
        assertTrue(File(realBaseline, "part1").isFile)
        assertFalse(rs.exists())
        assertFalse(ro.exists())
    }

    @Test fun sweepStaleWithoutPidFallsBackToMtime() {
        val runtime = tmp.newFolder()
        val parts = File(runtime, "parts").apply { mkdirs() }
        val now = System.currentTimeMillis()
        val young = File(parts, ".staging-r1-1234").apply { mkdirs() }
        young.setLastModified(now - 60_000)
        val ancient = File(parts, ".staging-r1-5678").apply { mkdirs() }
        ancient.setLastModified(now - 25L * 60 * 60 * 1000)

        // currentPid 默认 -1 ⇒ 不看 pid，只看 mtime
        assertEquals(listOf("parts/.staging-r1-5678"), RuntimeFiles.sweepStale(runtime))
        assertTrue(young.isDirectory)
        assertFalse(ancient.exists())
    }

    // ---------- A-1：GithubMirrors 选路（注入 probe，不碰网络） ----------

    private val dlUrl = "https://github.com/o/r/releases/download/v1/rootfs-part1-arm64-v8a.tar.xz"

    /** 假探测：按 URL 查表；`counter` 用来断言"到底探了几次"。 */
    private fun fakeProbe(
        table: Map<String, GithubMirrors.Probe>,
        counter: java.util.concurrent.atomic.AtomicInteger? = null,
    ): (String, String, Long, Int, Long) -> GithubMirrors.Probe =
        { name, url, _, _, _ ->
            counter?.incrementAndGet()
            table[url] ?: GithubMirrors.Probe(name, url, ok = false, error = "not in table")
        }

    @Test fun mirroredOnlyRewritesReleaseDownloadUrls() {
        GithubMirrors.clearCache()
        // 非 github.com：不镜像
        assertTrue(GithubMirrors.mirrored("https://example.com/x/releases/download/v1/a").isEmpty())
        // github.com 但不在 /releases/download/ 下（比如 atom）：不镜像
        assertTrue(GithubMirrors.mirrored("https://github.com/o/r/releases.atom").isEmpty())
        assertTrue(GithubMirrors.mirrored("https://api.github.com/repos/o/r/releases").isEmpty())
        // 正常分片：条目数 == 表大小，且**没有双斜杠**
        val m = GithubMirrors.mirrored(dlUrl)
        assertEquals(GithubMirrors.mirrorCount, m.size)
        for ((_, url) in m) {
            assertFalse("拼接出现双斜杠：$url", url.contains(".top//") || url.contains(".com//") || url.contains("net//"))
            assertTrue(url.endsWith(dlUrl))
            assertTrue(url.startsWith("https://"))
        }
        // rewriteOne(null) 原样返回
        assertEquals(dlUrl, GithubMirrors.rewriteOne(null, dlUrl))
    }

    @Test fun pickPrefersDirectWhenFastEnough() {
        GithubMirrors.clearCache()
        val counter = java.util.concurrent.atomic.AtomicInteger()
        // 直连两次探测（1 字节探活 + 64KB 速测）都很快 ⇒ 应直接返回直连，**不探镜像**
        val probe = fakeProbe(
            mapOf(dlUrl to GithubMirrors.Probe("direct", dlUrl, ok = true, ranges = true,
                rttMs = 50, bytesPerSec = 2L * 1024 * 1024)),
            counter,
        )
        val c = GithubMirrors.pick(dlUrl, 1000L, probe = probe)
        assertNull("直连达标时 base 必须是 null（= 不走镜像）", c.base)
        assertEquals("direct", c.name)
        assertEquals("直连只该探 2 次（探活 + 速测）", 2, counter.get())
    }

    @Test fun pickChoosesFastestMirrorAndExcludesNonRange() {
        GithubMirrors.clearCache()
        val mirrors = GithubMirrors.mirrored(dlUrl)
        val fastName = mirrors.keys.first()
        val slowName = mirrors.keys.elementAt(1)
        val noRangeName = mirrors.keys.elementAt(2)

        val table = HashMap<String, GithubMirrors.Probe>()
        // 直连慢（但可用）
        table[dlUrl] = GithubMirrors.Probe("direct", dlUrl, ok = true, ranges = true,
            rttMs = 900, bytesPerSec = 10_000)
        table[mirrors[fastName]!!] = GithubMirrors.Probe(fastName, mirrors[fastName]!!,
            ok = true, ranges = true, rttMs = 80, bytesPerSec = 1_500_000)
        table[mirrors[slowName]!!] = GithubMirrors.Probe(slowName, mirrors[slowName]!!,
            ok = true, ranges = true, rttMs = 120, bytesPerSec = 300_000)
        // 最快但**不支持 Range** ⇒ 必须被排除（否则块下载会 O(n²)）
        table[mirrors[noRangeName]!!] = GithubMirrors.Probe(noRangeName, mirrors[noRangeName]!!,
            ok = true, ranges = false, rttMs = 1, bytesPerSec = 9_000_000)

        val c = GithubMirrors.pick(dlUrl, -1L, budgetMs = 300, probe = fakeProbe(table))
        assertNotNull("应选中某条镜像", c.base)
        assertEquals(fastName, c.name)
        assertEquals("mirror:$fastName", c.via)
        assertFalse("不该排除成 degraded", c.degraded)
        // base 是镜像**前缀**（如 https://ghfast.top/），用它改写必须得到完整镜像 URL
        assertEquals(mirrors[fastName], GithubMirrors.rewriteOne(c.base, dlUrl))
        assertEquals("base 应等于镜像前缀（去掉原 url 后缀）",
            mirrors[fastName]!!.removeSuffix(dlUrl), c.base)
    }

    @Test fun pickFallsBackToDirectWhenEveryMirrorFails() {
        GithubMirrors.clearCache()
        val table = mapOf(
            dlUrl to GithubMirrors.Probe("direct", dlUrl, ok = false, error = "no range"),
        )
        val c = GithubMirrors.pick(dlUrl, -1L, budgetMs = 200, probe = fakeProbe(table))
        assertNull("全灭时必须回退直连", c.base)
        assertEquals("direct", c.name)
        assertTrue("没有任何镜像可用应标记 degraded", c.degraded)
    }

    @Test fun pickCachesChoiceAndReusesIt() {
        GithubMirrors.clearCache()
        val counter = java.util.concurrent.atomic.AtomicInteger()
        val table = mapOf(dlUrl to GithubMirrors.Probe("direct", dlUrl, ok = true,
            ranges = true, rttMs = 50, bytesPerSec = 2L * 1024 * 1024))
        val probe = fakeProbe(table, counter)

        val first = GithubMirrors.pick(dlUrl, 1000L, probe = probe)
        val afterFirst = counter.get()
        assertNull(first.base)

        // 第二次：命中缓存（直连缓存直接返回，不再探测）
        val second = GithubMirrors.pick(dlUrl, 1000L, probe = probe)
        assertEquals(first, second)
        assertEquals("缓存命中不该再探测", afterFirst, counter.get())

        // 换个 URL ⇒ 缓存失效，必须重新探
        val other = dlUrl.replace("part1", "part2")
        GithubMirrors.pick(other, 1000L, probe = probe)
        assertTrue("不同 URL 必须重新探", counter.get() > afterFirst)
        GithubMirrors.clearCache()
    }

    @Test fun pickWithNoMirrorCandidatesStaysDirect() {
        GithubMirrors.clearCache()
        // 不是 release 下载 URL ⇒ 没有镜像候选；也没传 probe 表 ⇒ 直连失败
        val c = GithubMirrors.pick("https://example.com/whatever.bin", -1L, budgetMs = 100,
            probe = fakeProbe(emptyMap()))
        assertNull(c.base)
        assertTrue(c.degraded)
    }

    // ---------- A-1b：atom 用独立镜像表（"补入口"） ----------

    @Test fun atomUsesDedicatedMirrorListNotTheDownloadOne() {
        GithubMirrors.clearCache()
        val atom = "https://github.com/o/r/releases.atom"

        // atom 的路径不是 /releases/download/ ⇒ 分片表**不该**给它候选
        assertTrue("分片表不该匹配 atom", GithubMirrors.mirrored(atom).isEmpty())
        // 但 atom 专用表必须给它候选（实测只有 gh-proxy.com 能转普通 URL）
        val m = GithubMirrors.atomUrls(atom)
        assertTrue("atom 必须有镜像候选（否则入口是单点）", m.isNotEmpty())
        assertEquals(GithubMirrors.atomMirrorCount, m.size)
        for ((_, url) in m) {
            assertTrue("拼接应保留原 URL 后缀", url.endsWith(atom))
            assertTrue("必须是 https", url.startsWith("https://"))
            assertFalse("不该出现双斜杠", url.contains("//https"))
        }

        // 反向：分片 URL 不该走 atom 表
        assertTrue("atom 表不该匹配分片", GithubMirrors.atomUrls(dlUrl).isEmpty())
        // 非 github host 一律不给
        assertTrue(GithubMirrors.atomUrls("https://example.com/x").isEmpty())
    }

    @Test fun atomMirrorListIsSubsetOfTheWorkingMirrors() {
        GithubMirrors.clearCache()
        // 能转 atom 的镜像必须同时在分片表里 —— 否则说明两张表不一致，
        // 那种线路在真实链路上会「atom 拿到了、分片却换另一条」，排查困难。
        val atomNames = GithubMirrors.atomUrls("https://github.com/o/r/releases.atom").keys
        val dlNames = GithubMirrors.mirrored(dlUrl).keys
        assertTrue("atom 表不能为空", atomNames.isNotEmpty())
        for (n in atomNames) {
            assertTrue("atom 镜像 $n 必须也在分片表里", n in dlNames)
        }
        // 分片表应该比 atom 表大（实测 5 vs 1）
        assertTrue(
            "分片表应≥atom 表（实测 5 vs 1），实际 ${dlNames.size} vs ${atomNames.size}",
            dlNames.size >= atomNames.size,
        )
    }
}
