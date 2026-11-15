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
        assertEquals(listOf("engine", "usr", "termux/usr"), RuntimeFiles.retireLegacy(root))
        protectedPaths.forEach { assertEquals(it, File(root, it).readText()) }
        assertFalse(File(root, "usr").exists())
        assertEquals(3, File(root, "runtime/legacy-bionic").listFiles()!!.size)
        assertTrue(RuntimeFiles.retireLegacy(root).isEmpty())
    }
    @Test fun legacySymlinkIsMovedWithoutTraversingUserData() {
        val root = tmp.newFolder()
        val data = file(root, "home/.dsh/sessions/a", "still here")
        Files.createSymbolicLink(File(root, "usr").toPath(), data.parentFile.toPath())
        assertEquals(listOf("usr"), RuntimeFiles.retireLegacy(root))
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
}