# proot 二进制供给（G-23：G-03 的唯一剩余硬依赖）

> `AlpineRuntime` 需要两个文件才能在设备上跑：
>
> ```text
> filesDir/bin/libproot.so         ← proot 本体（可执行 ELF，伪装成 .so 才不会被 APK 压缩/剥离）
> filesDir/bin/proot-loader.so     ← proot 的用户态 loader
> ```
>
> 缺任何一个，`AlpineRuntime.availability()` 返回 `ProotMissing`，引擎**自动回退 Termux 档**
> ——不会崩，但 Alpine 也用不上。App 侧代码已经就绪（`com.dsh.android.runtime`），只等这两个文件。

## 为什么不能直接从 Termux 的 deb 里拿

Termux 的 `proot` 是 bionic 编译，**能跑**，但它的 RUNPATH 写死成：

```text
/data/data/com.termux/files/usr/lib
```

而 DSHAPP 的私有目录是：

```text
/data/user/0/com.dsh.android/files/...
```

两条路径长度不同，**不能像 node 那样做等长 `.dynstr` 覆盖**。所以只有两条正路：

## 路线 A（推荐）：自己编，交叉到 aarch64 + bionic

```bash
# 依赖：Android NDK r27+、git
git clone https://github.com/termux/proot.git
cd proot/src
export NDK=$HOME/android-ndk-r27
export TARGET=aarch64-linux-android
export API=24
export CC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/${TARGET}${API}-clang

make -j"$(nproc)" \
  CFLAGS="-DARG_MAX=131072 -D_FILE_OFFSET_BITS=64 -D_GNU_SOURCE" \
  LDFLAGS="-static-libgcc -Wl,--gc-sections"

# 产物：src/proot（可执行 ELF）
# 同时需要 loader：loader/loader-m32 / loader/loader（取决于配置）
```

产出后改名并放到 jniLibs（这样 APK 不会二次压缩，`nativeLibraryDir` 里直接可执行）：

```text
app/src/main/jniLibs/arm64-v8a/libproot.so
app/src/main/jniLibs/arm64-v8a/libproot-loader.so
```

`AlpineRuntime` 的 `candidates()` 会依次找：

```text
filesDir/bin/libproot.so
nativeLibraryDir/libproot.so
filesDir/termux/usr/bin/proot        （兜底：Termux 里装过 proot 就直接借用）
```

## 路线 B（应急）：从 Operit 的 APK 里抠

Operit（`AAswordman/Operit`）用 PRoot + Alpine 跑通过，它的 APK 里就有可用的
`libproot.so` / `libproot-loader.so`（`lib/arm64-v8a/` 下）。抠出来放进本工程的 jniLibs 即可。

> ⚠️ 注意许可证：Operit 是 AGPL-3.0（proot 本体是 GPL-2.0）。把二进制分发进 APK 属于再分发，
> 要保留许可证与来源说明。这条是合规要求，不是"建议"。

## 验收

```bash
# 设备上
adb shell run-as com.dsh.android ls -l files/bin/ 2>/dev/null || \
  adb shell ls -l /data/user/0/com.dsh.android/files/bin/

# App 日志里应出现
#   DSH/AlpineRuntime: 已切到 alpine 档：rootfs=alpine proot=libproot.so
# 否则会出现
#   DSH/AlpineRuntime: alpine 档不可用，回退 Termux：... 缺 libproot.so
```

## 现状

| 项 | 状态 |
|---|---|
| `AlpineProvisioner`（解包 165 MB / sha256 / 空间预检） | ✅ 已写（`com.dsh.android.runtime`） |
| `TarGzExtractor`（纯 Kotlin，支持长名/符号链接/权限位） | ✅ 已写 |
| `AlpineRuntime`（拼 proot 命令 + env 覆盖） | ✅ 已写 |
| `EngineManager` 接入（1 处命令行 + 1 处 env） | ✅ 已改，未可用时**零行为变化** |
| **`libproot.so` / `proot-loader.so`** | ⬜ **缺**（本文档就是给它准备的） |

---

## CI 实测诊断链（`proot-android` workflow，已跑 8 轮）

> 结论先说：**NDK 侧没问题**（编译器/目标 triple 都对），卡在 **talloc 的构建系统**。
> 下面是逐轮的真实报错与修法，接着往下做的人不必再踩一遍。

| 轮 | 报错 | 根因 | 处理 |
|---|---|---|---|
| 1 | `waf: error: no such option: --disable-shared`、`shm.c: No such file` | talloc 2.4.2 的 waf 不认那组选项；libandroid-shmem 的源文件名不是 `shm.c` | 选项改成"先 `--help` 再拼"；源码用 `find` 找 |
| 2 | `Checking simple C program : not found` → `The configuration failed` | waf 默认要**运行**探测程序，aarch64 二进制在 x86 runner 上跑不了 | 加 `--cross-compile` |
| 3 | `Cannot cross-compile without either --cross-execute or --cross-answers` | 新版 waf 拒绝裸 `--cross-compile` | 改 `--cross-execute=/bin/true` |
| 4 | 仍然 `Checking simple C program : not found` | `./configure ... \| tail` —— pipeline 退出码是 `tail` 的，失败分支永远不进 | 改成 `> log 2>&1` 再判 |
| 5 | `OSError: [Errno 8] Exec format error: …/testprog` | talloc 的 wscript **不读** `cross_execute`，还是直接 exec 产物 | 放弃 waf，改手编 `talloc.c` |
| 6 | `fatal error: 'replace.h' file not found` | 独立 talloc 包**不带** samba 的 `replace.h`（它假设自己在 samba 源码树里） | 生成最小 `replace.h` / `config.h` |
| 7-8 | `talloc.c` 仍编不过；proot 侧 `talloc.h file not found` 连锁失败 | 最小 `replace.h` 缺 samba 的宏/类型（`_PUBLIC_` 之外的 `HAVE_*`、`bool` 细节等） | 未解决 → 见下方三条路 |

### 接着做的三条路（按性价比排序）

1. **直接给二进制（最省事）**：把任意含 proot 的 APK（Operit / Termux 的 proot 包）放到工作区，
   `unzip -j app.apk 'lib/arm64-v8a/libproot*.so'` 拿到即可。**不要再花时间编。**
2. **走 samba 源码树**：`talloc.c` 需要 samba 的 `lib/replace`。下载 `samba-4.20.x.tar.gz`（~30 MB），
   用 `-I lib/replace` + 该目录的 `config.h`（由 samba 的 configure 生成或手补）再编。
3. **给 runner 装 qemu-user-static 后回头用 waf**：`sudo apt-get install qemu-user-static` +
   `--cross-execute=qemu-aarch64-static`，让 waf 真的"运行"aarch64 探测程序。
   > 这是最符合上游预期的做法，但要求 runner 上 qemu 能跑 bionic 动态链接的测试程序（静态编译的 probe 才行）。

### 已经确认没问题的部分

- NDK 27.3 的 `aarch64-linux-android24-clang` 可用，`llvm-ar` / `llvm-ranlib` 齐全
- `libandroid-shmem` 能编（`shm.c` 找到并产出 `.a`）
- proot 的 `src/GNUmakefile` 只需要 `-ltalloc`（`src/Makefile` 里没有 talloc 引用，说明用它自己的构建入口）
