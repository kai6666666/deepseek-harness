package ai.deepseek.harness

import java.io.File

/**
 * 环境配置 —— 移植自 Operit 的「环境包 + 镜像源」体系。
 *
 * Operit 拆成三块：`install_ubuntu`（装 rootfs）、`configure_sources`（换镜像源）、
 * `fix_permissions`（修属主/权限）。我们这边：
 *   - rootfs 用分层镜像（layer0/layer1）替代在线安装；
 *   - 镜像源、缓存清理、按生态装包，就是本文件；
 *   - 权限修正在 install 完成后顺手做掉。
 */
enum class Ecosystem(val id: String, val label: String) {
    APT("apt", "系统包"),
    NPM("npm", "Node 包"),
    PIP("pip", "Python 包"),
    CARGO("cargo", "Rust 包"),
}

data class MirrorPreset(
    val id: String,
    val label: String,
    val apt: String,
    val npm: String,
    val pip: String,
) {
    companion object {
        val presets = listOf(
            MirrorPreset(
                "official", "官方源",
                "http://archive.ubuntu.com/ubuntu",
                "https://registry.npmjs.org",
                "https://pypi.org/simple",
            ),
            MirrorPreset(
                "aliyun", "阿里云",
                "https://mirrors.aliyun.com/ubuntu",
                "https://registry.npmmirror.com",
                "https://mirrors.aliyun.com/pypi/simple",
            ),
            MirrorPreset(
                "tuna", "清华 TUNA",
                "https://mirrors.tuna.tsinghua.edu.cn/ubuntu",
                "https://registry.npmmirror.com",
                "https://pypi.tuna.tsinghua.edu.cn/simple",
            ),
            MirrorPreset(
                "ustc", "中科大",
                "https://mirrors.ustc.edu.cn/ubuntu",
                "https://registry.npmmirror.com",
                "https://mirrors.ustc.edu.cn/pypi/simple",
            ),
        )

        fun byId(id: String): MirrorPreset? = presets.firstOrNull { it.id.equals(id, true) }
    }
}

object EnvManager {

    private const val UBUNTU_SUITE = "noble"

    /** rootfs 里的配置文件位置（proot 内路径 → 宿主机真实路径） */
    private fun rootfs(ctx: android.content.Context): File =
        File(ctx.filesDir, "usr/var/lib/proot-distro/installed-rootfs/ubuntu")

    fun isReady(ctx: android.content.Context): Boolean =
        File(rootfs(ctx), "usr/local/bin/node").isFile

    // --------------------------------------------------------------- 源

    /** 对应 Operit 的 `configure_sources` */
    fun applyMirror(ctx: android.content.Context, preset: MirrorPreset): List<String> {
        val root = rootfs(ctx)
        val touched = mutableListOf<String>()

        runCatching {
            val f = File(root, "etc/apt/sources.list")
            f.parentFile?.mkdirs()
            f.writeText(
                buildString {
                    appendLine("deb ${preset.apt} $UBUNTU_SUITE main restricted universe multiverse")
                    appendLine("deb ${preset.apt} $UBUNTU_SUITE-updates main restricted universe multiverse")
                    appendLine("deb ${preset.apt} $UBUNTU_SUITE-security main restricted universe multiverse")
                }
            )
            touched += "etc/apt/sources.list"
        }

        runCatching {
            val f = File(root, "root/.npmrc")
            f.parentFile?.mkdirs()
            f.writeText("registry=${preset.npm}\n")
            touched += "root/.npmrc"
        }

        runCatching {
            val f = File(root, "etc/pip.conf")
            f.parentFile?.mkdirs()
            f.writeText("[global]\nindex-url = ${preset.pip}\ntrusted-host = ${java.net.URI(preset.pip).host}\n")
            touched += "etc/pip.conf"
        }

        return touched
    }

    fun currentMirror(ctx: android.content.Context): String {
        val f = File(rootfs(ctx), "root/.npmrc")
        if (!f.isFile) return "unknown"
        val line = f.readLines().firstOrNull { it.startsWith("registry=") } ?: return "unknown"
        val url = line.removePrefix("registry=").trim()
        return MirrorPreset.presets.firstOrNull { it.npm == url }?.id ?: url
    }

    // --------------------------------------------------------------- 装包

    /** 对应 Operit 环境包里的 `apt/pip/npm install`；返回给模型看的输出尾部 */
    fun installCommand(eco: Ecosystem, packages: List<String>, mirror: MirrorPreset?): String =
        buildString {
            mirror?.let { m ->
                appendLine("export npm_config_registry=${m.npm}")
                appendLine("export PIP_INDEX_URL=${m.pip}")
            }
            when (eco) {
                Ecosystem.APT ->
                    append("DEBIAN_FRONTEND=noninteractive apt-get update -qq && " +
                        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.joinToString(" ")}")
                Ecosystem.NPM -> append("npm install -g ${packages.joinToString(" ")}")
                Ecosystem.PIP -> append("pip3 install --break-system-packages ${packages.joinToString(" ")}")
                Ecosystem.CARGO -> append("cargo install ${packages.joinToString(" ")}")
            }
        }

    /** 对应 Operit 的 `fix_permissions`：把 root 家目录与工作区交给容器内 root */
    fun fixPermissionsScript(): String = """
        chmod 755 /root /root/.npm /root/.cache 2>/dev/null || true
        chmod -R u+rwX /root/.npm /root/.cache /usr/local/lib/node_modules 2>/dev/null || true
        mkdir -p /root/workspace && chmod 777 /root/workspace 2>/dev/null || true
        true
    """.trimIndent()

    fun cleanScript(): String = """
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /root/.npm/_cacache /tmp/* 2>/dev/null || true
        echo cleaned
    """.trimIndent()

    // --------------------------------------------------------------- 状态

    fun status(ctx: android.content.Context): String {
        val root = rootfs(ctx)
        val node = File(root, "usr/local/bin/node")
        val dsh = File(root, "usr/local/lib/node_modules/@deepseek-ai/dsh/package.json")
        return buildString {
            appendLine("rootfs=${if (root.isDirectory) "ok" else "missing"} (${root.absolutePath})")
            appendLine("node=${if (node.isFile) "ok" else "missing"}")
            appendLine("dsh=${if (dsh.isFile) "ok" else "missing"}")
            appendLine("mirror=${currentMirror(ctx)}")
            appendLine("apt_list=${File(root, "etc/apt/sources.list").let { if (it.isFile) it.readLines().firstOrNull().orEmpty() else "-" }}")
            appendLine("presets=${MirrorPreset.presets.joinToString("/") { it.id }}")
            append("ecosystems=${Ecosystem.entries.joinToString("/") { it.id }}")
        }
    }
}