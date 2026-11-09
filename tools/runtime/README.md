# 单运行时构建（PRoot + glibc）

产出三个东西，供 App 的 `ProotHost` 直接消费：

```text
<out>/arm64-v8a/assets/runtime/rootfs-arm64-v8a.tar.xz   运行时（Ubuntu 24.04.5 + node 24.22.1 + dsh 0.2.2-rc.1）
<out>/arm64-v8a/assets/runtime/manifest.json             版本/哈希/启动模板/健康判据
<out>/arm64-v8a/jniLibs/arm64-v8a/*.so                   proot / loader / talloc / shmem
```

## 用法

```bash
tools/runtime/build-runtime.sh                          # 全量
DSH_RT_SKIP_ENGINE=1 tools/runtime/build-runtime.sh     # 只做 base+node（~1 分钟，自检用）
DSH_RT_OUT=/path tools/runtime/build-runtime.sh         # 自定义产物目录
DSH_RT_PRUNE=0 tools/runtime/build-runtime.sh           # 不瘦身（排障用）
```

环境变量可覆盖版本：`DSH_VERSION` / `NODE_VERSION` / `UBUNTU_VERSION` / `PROOT_VERSION`。

## 目录约定

| 路径 | 用途 |
|---|---|
| `/root/dsh-runtime-build`（`DSH_RT_WORK`） | 组装工作区，**必须在 ext4** |
| `/root/.cache/dsh-runtime`（`DSH_RT_CACHE`） | 下载缓存（ubuntu / node / termux deb / npm） |
| `_build/runtime/out`（`DSH_RT_OUT`） | 产物，只写这里 |

## 三个必须知道的坑

1. **不要在 proot（--link2symlink）里用 `tar -x` 解包**：硬链接会被改写成 `.l2s.*` 符号链接链，随后打包报
   `Too many levels of symbolic links`。本目录的 `extract.py` 用 `tarfile` 逐条解，硬链接直接复制成独立文件。
2. **`/sdcard` 是 FUSE，不能建符号链接**：`dpkg-deb -x`、rootfs 组装都会失败。产物可以落在工作区，组装必须在 ext4。
3. **`libtalloc.so.2` 不会被 Android 抽取**（只认 `lib*.so`）：必须改名 `libtalloc.so` 并用
   `patchelf --replace-needed` 改 `DT_NEEDED`；proot 的 `RUNPATH` 指向 Termux 路径，运行期靠 `LD_LIBRARY_PATH` 兜。

## 门禁（2026-11-09 实测）

```text
node -v                     → v24.22.1
dsh --version               → 0.2.2-rc.1
rootfs 解包                  → 997 MB
rootfs tar.xz               → 124 MB
两次构建 sha256              → 一致（a9593add…）
```

## manifest 的契约

- `launch.argv` 是模板，Kotlin 只做占位符替换：`{NATIVE_LIB_DIR}` `{ROOTFS}` `{TMP}` `{PORT}`，以及独立元素 `{GUEST_ENV}`
- `launch.env`：`PROOT_LOADER` / `PROOT_TMP_DIR` / `PROOT_L2S_DIR` / `LD_LIBRARY_PATH`
- `tokenLine.regex`：从 stdout 抓 `dsh web: http://127.0.0.1:<port>/?token=…`
- `health`：TCP 可连 + 无 cookie 401 + 带 cookie 200
- `stop`：`SIGTERM` 给 pidfile 里的 node；兜底 `SIGQUIT` 给 proot（proot 忽略 SIGTERM/SIGINT/SIGHUP）