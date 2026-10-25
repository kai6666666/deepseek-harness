# 版本矩阵（G-15）

> 本文件由 `tools/gen-version-matrix.mjs` **自动生成**，不要手改。
> 校验：`node tools/gen-version-matrix.mjs --check`（CI 里挂闸门）。

## 1. 一个 APK 里到底装了什么

| 组件 | 版本 | 来源（仓库内路径） |
|---|---|---|
| DSH Android 客户端 | `versionCode 38` / `0.4.1-debug` | `app/build.gradle.kts` |
| Alpine rootfs | alpine `3.23.0` | `app/src/main/assets/runtime/alpine-rootfs.manifest.json` |
| Node（guest 内） | `24.22.1-r0` | 同上 |
| rootfs 包体 | `58101022` B / sha256 `d253d66ff07a2d10…` | 同上 |
| rootfs 构建时间 | `2026-10-24T17:04:21Z` | 同上 |
| proot | `5.1.107.101` | packages.termux.dev/apt/termux-main（aarch64 deb 提取，见 tools/proot/README.md） |
| libtalloc | `2.5.0` | 同上 |
| libandroid-shmem | `0.7` | 同上 |
| jniLibs 实况 | libproot.so ✓ / libtalloc.so ✓ / libandroid-shmem.so ✓ | `app/src/main/jniLibs/arm64-v8a/` |
| 解包安全水位 | `80` MB | `AlpineProvisioner.SAFETY_MARGIN` |

## 2. rootfs 里的关键包

```text
- bash
- nodejs~24
- npm
- pnpm
- python3
- py3-pip
- openssh
- ca-certificates
- tzdata
```

## 3. 兼容边界（出问题先看这里）

| 维度 | 约束 | 违反后的症状 |
|---|---|---|
| ABI | 只支持 `arm64-v8a` / `x86_64`（`Abi.SUPPORTED`） | `ProotMissing`→其实是 `UnsupportedAbi`；提前判定，日志会写明设备 ABI |
| libc | bionic（Android），**不是** glibc/musl | `Exec format error` / `libc.so.6: not found` |
| 落地路径 | 必须在 `filesDir` 之下（`RuntimePaths.assertExecutableRoot`） | `/storage`、`/sdcard` 是 FUSE noexec → node 无法 exec |
| Node ABI | N-API 8（跨 Node 20/22/24/26 稳定） | 插件 `.node` 加载失败 |
| 空间 | 解包需 ≥ `包体 × 3` 或 `上次实测 × 1.1`，且过程中留 80 MB | 半途 ENOSPC → 已清理 staging，可重试 |

## 4. 升级时要一起动的东西

```text
换 rootfs   → alpine-rootfs.manifest.json（bytes/sha256/nodejs/alpine/builtAt 四件套全变）
              + .ready 三行格式不变（sha / 实测字节 / ts）→ 首启会重新解包
换 proot    → PROOT_PIN（本脚本）+ jniLibs 三个 .so + tools/proot/README.md
换客户端    → versionCode 单调递增；release key 永久固定（signing/dsh-release.jks）
```
