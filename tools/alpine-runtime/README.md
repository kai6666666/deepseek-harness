# alpine-runtime —— 双档中的「Alpine PRoot」骨架

```text
默认档（生态）  alpine：PRoot + Alpine/musl → process.platform='linux'，DSH 官方 musl prebuild 零补丁命中
性能档（重活）  termux：bionic 原生，直通不拦截
沙箱            两档都用 proot -b 白名单：-r 之后宿主根默认不可见，未绑定的路径根本不存在
```

## 文件

| 文件 | 作用 |
|---|---|
| `build-rootfs.sh` | 在 x86_64 Linux/WSL 用 `apk.static --root` 交叉构建 aarch64 rootfs，产出 `alpine-rootfs.tar.gz` + `.sha256` + `rootfs.manifest.json` |
| `proot-launch.sh` | 启动链单入口：`--backend` / `--sandbox` / `--cwd` / `--dry-run`，termux 档直通 |
| `pathmap.mjs` | host ↔ guest 路径映射（与 `-b` 绑定表一一对应），自带 9 条 self-test |
| `backend-select.mjs` | 双档开关：`state` / `doctor` / `switch` / `resolve`，状态落 `$DSH_HOME/backend.json` |
| `verify-rootfs.sh` | 设备侧 5 项启动验收 |

## 1. 构建 rootfs

> **构建环境是硬要求：必须能原生执行 x86_64 静态二进制（WSL2 / CI / 真 Linux / 容器）。**
> 在 PRoot 或 chroot 里跑 `apk.static` 会直接 `Bus error`（exit 135）——
> 这不是脚本错，是 PRoot 的 mmap 语义不满足。脚本已在第 3 步做预检，会明确报这条。

```bash
cd DSHAPP-main
bash tools/alpine-runtime/build-rootfs.sh --dry-run      # 先看要下载什么
bash tools/alpine-runtime/build-rootfs.sh                # 真构建（默认 v3.23 + nodejs~24）
cp tools/alpine-runtime/out/alpine-rootfs.tar.gz app/src/main/assets/alpine-rootfs.bin
cp tools/alpine-runtime/out/rootfs.manifest.json app/src/main/assets/alpine-rootfs.manifest.json
```

**为什么要用 `apk.static --root`**：它是 Alpine 官方的「交叉安装」模式，在 x86_64 上就能把 aarch64 包装进目标 rootfs，不需要 qemu、不需要 chroot、不需要 root。

**版本怎么查**（改 `--alpine` 前必做）：

```bash
# 支持的 minirootfs 版本
curl -s https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/ | grep -o 'alpine-minirootfs-[0-9.]*-aarch64.tar.gz' | tail -3
# apk-tools-static 的准确版本（默认 2.14.4-r0，换分支要同步）
curl -s https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64/ | grep -o 'apk-tools-static-[0-9.]*-r[0-9]*.apk' | tail -1
```

**Node 版本约束**：DSH 要 `^22.19 || >=24`。Alpine 3.20 只有 node 20，所以默认取 **3.21**；不够新就 `--pkgs "nodejs-current ..."`。

## 2. 首次启动解包（App 侧）

```text
assets/alpine-rootfs.bin  ──解压──▶  $DSH_HOME/alpine/            （rootfs）
assets/alpine-rootfs.manifest.json   校验 sha256 / bytes 后再解
$DSH_HOME/bin/libproot.so              proot 主程序（改名成 lib*.so 可进 nativeLibraryDir）
$DSH_HOME/bin/proot-loader.so          PROOT_LOADER
```

校验逻辑照 `alpine-rootfs.manifest.json` 的 `sha256` 与 `bytes`，任何不符就整包重来——**不要“跳过校验继续跑”**。

## 3. 启动链

```bash
# 预演：只打印最终 argv，不执行
DSH_HOME=/data/data/com.dsh.android/files/.dsh \
  bash tools/alpine-runtime/proot-launch.sh --dry-run -- /usr/bin/node -p 'process.platform'

# 真跑：in-guest 的 node
DSH_HOME=... bash tools/alpine-runtime/proot-launch.sh -- \
  /usr/bin/node -p 'process.platform + "/" + (process.report.getReport().header.glibcVersionRuntime?"glibc":"musl")'
# → linux/musl

# 跑 dsh 引擎
DSH_HOME=... bash tools/alpine-runtime/proot-launch.sh --backend alpine --cwd /workspace -- \
  /usr/bin/node /dsh-home/engine/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open
```

生成的 argv 形如：

```text
libproot.so -r <rootfs> -0 -w /workspace
  -b /dev:/dev -b /proc:/proc -b /sys:/sys -b <DSH_HOME>:/dsh-home -b <WS>:/workspace
  --kill-on-exit /usr/bin/env -i PROOT_NO_SECCOMP=1 PROOT_LOADER=… HOME=/root … -- <cmd>
```

**沙箱语义（重点）**：

- `proot -r <rootfs>` 之后，**宿主根不会自动出现在 guest 里**；只有 `-b` 显式绑定的路径存在。
- 所以 `-b` 列表**就是白名单**，比 `LD_PRELOAD` 拦截器硬：guest 里 `/data/data/...` 根本不存在，不是“被拒绝”。
- `readonly` 档 = **不绑定 workspace**（proot 的 `-b` 没有 `:ro` 选项，别写 `:ro`，会被当路径）。
- 两档都不隔离 PID（`--unshare-pid` 需要 CAP_SYS_ADMIN，普通应用拿不到），这一点和现状一致。

## 4. 路径映射

| host | guest |
|---|---|
| `/storage/emulated/0` | `/sdcard` |
| `$DSH_HOME` | `/dsh-home` |
| `$DSH_WORKSPACE` | `/workspace` |
| `$DSH_ALPINE_ROOTFS/**` | `/` |

```bash
node tools/alpine-runtime/pathmap.mjs table
node tools/alpine-runtime/pathmap.mjs self-test     # 9/9
node tools/alpine-runtime/pathmap.mjs to-guest "/storage/emulated/0/MT2/x.md"   # /sdcard/MT2/x.md
```

> **改 `-b` 必须同时改 `pathmap.mjs`**，两处是同一张表的两个投影。

## 5. 双档切换

```bash
node tools/alpine-runtime/backend-select.mjs state      # 当前档 + 两档可用性
node tools/alpine-runtime/backend-select.mjs doctor     # 缺什么 + 修复命令
node tools/alpine-runtime/backend-select.mjs switch alpine
eval "$(node tools/alpine-runtime/backend-select.mjs resolve)"   # 灌进环境变量
```

规则：

```text
显式 --backend  >  $DSH_HOME/backend.json  >  自动探测（能 alpine 就 alpine）
alpine 不可用且非 --strict  →  回退 termux 并打印原因
```

## 6. 接进 EngineManager（Kotlin 侧）

```kotlin
// 读档位，决定用哪套 args；不改引擎本身
private fun backend(): String =
    runCatching {
        JSONObject(File(File(filesDir, ".dsh"), "backend.json").readText()).optString("backend")
    }.getOrNull()?.takeIf { it == "alpine" || it == "termux" } ?: "termux"

private fun engineArgs(): List<String> = if (backend() == "alpine") {
    listOf("bash", "$filesDir/tools/proot-launch.sh", "--backend", "alpine",
           "--cwd", "/workspace", "--",
           "/usr/bin/node", "/dsh-home/engine/node_modules/@deepseek-ai/dsh/lib/bin.js",
           "--profile", "web", "--no-open")
} else {
    listOf("$prefixDir/bin/node",
           "$filesDir/engine/node_modules/@deepseek-ai/dsh/lib/bin.js",
           "--profile", "web", "--no-open")
}
```

## 7. 验收

```bash
bash tools/alpine-runtime/verify-rootfs.sh
```

五项判据：

```text
0) doctor 通过（rootfs / node / proot / loader 齐全）
1) guest 能执行      → PROOT_OK
2) process.platform  → linux          ← 这一条决定「生态位」
3) libc              → musl           ← 这一条决定「官方 prebuild 能不能直接吃」
4) 官方 flock 零补丁  → FLOCK_OK
5) dsh --dump-config 有输出
```

## 8. 已知边界

| 项 | 说明 |
|---|---|
| **性能** | 每个 syscall 过 ptrace，Node 类负载比 Termux 档慢（重编译/大批量文件操作切 Termux） |
| **无 `-b :ro`** | proot 不支持只读绑定；readonly = 不绑定 |
| **PID 不隔离** | 需 CAP_SYS_ADMIN，无 root 拿不到 |
| **SELinux 仍拦 link()** | 宿主侧写路径仍会碰 `EACCES`，需要 `liblinkcompat.so` 或改 `rename()` 兜底 |
| **rootfs 体积** | Alpine 基线 ~5 MB，装完 node/py/ssh ~50–80 MB（远小于 Ubuntu 的 500 MB+） |
| **不替代 Termux 档** | 两档共存：Alpine 管生态，Termux 管性能与重编译 |