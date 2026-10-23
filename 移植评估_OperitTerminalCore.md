# OperitTerminalCore 移植评估（实测）

生成时间：2026-10-23
来源：https://github.com/AAswordman/OperitTerminalCore.git（master 分支，zip 快照）
落盘位置：`Operit-main/terminal/`（已就位，替代空子模块）

---

## 1. 仓库实测数据

| 项 | 数值 |
|---|---|
| 文件数 | 68 |
| 总体积 | 68 MB |
| Kotlin 文件 | 47 |
| Kotlin 代码量 | 18,822 行 |
| 最大单文件 | `TerminalManager.kt` 1,404 行 |

### jniLibs/arm64-v8a（全部为真实 ELF，除标注）

| 文件 | 大小 | 类型 | 运行时改名 |
|---|---|---|---|
| `liboperit_proot.so` | 256,864 B | ELF aarch64 DYN | `proot` |
| `libbash.so` | 1,696,448 B | ELF aarch64 EXEC | `bash` |
| `libbusybox.so` | 1,498,688 B | ELF aarch64 EXEC | `busybox` |
| `liboperit_loader.so` | 1,632 B | ELF aarch64 EXEC | `loader` |
| `libsudo.so` | **2 B** | 文本 `$@`，**桩文件** | `sudo` |

### assets

| 文件 | 大小 | 解压后 |
|---|---|---|
| `ubuntu-noble-aarch64-pd-v4.18.0.tar.xz` | 61.2 MiB | 279.4 MiB / 12,684 条目 |
| `setup_fake_sysdata.sh` | 7,356 B | — |

实测解压整个 xz 流耗时约 **6 秒**（本机 Linux 环境下 tarfile 扫描），xz 不是瓶颈。

### 构建配置（`build.gradle.kts`）

- `minSdk = 26`、`compileSdk = 36`
- `packaging { jniLibs { useLegacyPackaging = true } }` ← 可执行二进制的正确打包方式
- `abiFilters += listOf("arm64-v8a")`
- `externalNativeBuild.cmake` → `src/main/jni/CMakeLists.txt` → `pty.c`

---

## 2. 能省多少（替换原方案阶段二 + 阶段三）

| 原方案工作项 | 原估 | 实测可得 | 省 |
|---|---|---|---|
| rootfs 下载器 + CDN + 断点续传 | 1 天 | zip 里已带 61MB rootfs，无需下载器 | 1 天 |
| XZ 解压库集成（`org.tukaani:xz`） | 0.5 天 | `busybox tar xf` 直接解 .xz | 0.5 天 + 1 依赖 |
| rootfs 安装器（幂等/锁/重试/进度） | 1 天 | `install_ubuntu()` 已实现 | 1 天 |
| proot 启动脚本拼装 | 1 天 | `generateStartScript()` 已实现 | 1 天 |
| PTY（node-pty 或自研） | 1.5 天 | `jni/pty.c` + `Pty.kt` 已实现 | 1.5 天 |
| **合计** | **约 5 人日** | **约 0.5 人日（搬 + 裁 UI）** | **≈4.5 人日** |

---

## 3. 白捡的 7 个坑位知识（这些重写一遍要烧掉一周）

1. **proot 启动探针**：`resolve_proot_runtime()` 先跑
   `proot -v1 -0 -r <rootfs> /usr/bin/env -i ... /bin/bash -c 'exit 0'`，
   失败时 `print_last_proot_probe_failure()` 打印 loader / seccomp / link2symlink / bind 参数诊断。
2. **`--link2symlink` 能力探测**：`probe_proot_link2symlink()` 通过后才启用，不硬写。
3. **每个 bind 逐个探针**：`probe_and_append_bind_arg()` —— 某个 bind 源不可访问就跳过，
   避免单条 `-b` 拖死整个容器。
4. **`/proc` 假文件补齐**：`/proc/stat`、`/proc/loadavg`、`/proc/uptime`、`/proc/version`、
   `/proc/vmstat`、`/proc/sys/kernel/cap_last_cap`、`/proc/sys/fs/inotify/max_user_watches`
   缺失时用 rootfs 内假文件补。这是 node / npm / vite 在 proot 里崩溃的头号原因。
5. **6 个 DNS 预写**（`write_default_dns()`）：8.8.8.8 / 1.1.1.1 / 223.5.5.5 / 223.6.6.6 / 119.29.29.29 / 180.76.76.76。
6. **`LD_LIBRARY_PATH=` 清空后 exec**：避免加载 Android 自带 libc。
7. **就绪信号**：登录后 `echo LOGIN_SUCCESSFUL; echo TERMINAL_READY` —— 宿主可解析，
   与 `dsh web: <授权URL>` 是同一套模式。

额外：`USE_CHROOT=1` 走 `busybox mount --bind` + `su -c` 的 chroot 模式（root 设备性能升级路径）。

---

## 4. 四个真缺口

1. **`libsudo.so` 是 2 字节桩**（内容就是 `$@`）。别指望 `bin/sudo`，`proot -0` 下本来就是假 root。
2. **只有 arm64-v8a**，32 位与 x86 模拟器不支持。
3. **61MB asset 直接进 APK**：需用 AAB / asset pack，或首次安装时下载。
4. **只搬 core，不要搬 UI**：必须裁掉 `ui/`、`view/canvas/`、`res/`（含 2.2MB 字体）、
   `provider/filesystem/SSH*`、FTP/SSHD 依赖；保留 `TerminalManager`、`TerminalService`(AIDL)、
   `Pty.kt`、`utils/SourceManager.kt`、`utils/CacheManager.kt`、`provider/UbuntuDocumentsProvider.kt`。

---

## 5. 对我上一轮说法的修正（有实测依据）

1. **"xz 解压是分钟级" —— 撤回。** 实测 61MB .tar.xz 全流解压约 6 秒，xz 不是瓶颈；
   原方案的 XZ 库选型错在"选了库"，不在"选了 xz"。zstd 改造属可选优化，不是必需。
2. **"降 targetSdk 28 绕 seccomp" —— 已从源码确认是错的**：
   `OperitTerminalCore` 与 `Operit-main` 都用 `targetSdk=34` + `useLegacyPackaging=true`。

---

## 6. 下一步

- [ ] 从 `TerminalManager.kt` 抽出 `generateStartScript()` 的 install 段，跑通「解压 → 探针 → 进入容器」
- [ ] 在容器内装 node ≥22.19，验证 `node -v`、`npm -v`
- [ ] 装 `@deepseek-ai/dsh`，跑 `dsh web --no-open --port 3080`，抓 stdout 的授权 URL
- [ ] 宿主持有 proot 子进程 PID，做死亡重启
