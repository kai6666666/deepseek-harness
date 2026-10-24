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
