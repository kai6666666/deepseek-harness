# 计划：体积、启动与增量更新（rc.5 之后）

> 状态：**P-1 / P0 已实施**（`0.2.2-rc.5-debug.2` / vc87）；P1–P6 待批。
> 关系：本文是 [refactor-single-host-purge.md](refactor-single-host-purge.md) 完成后的**性能线**，不改身份与架构。

---

## 0. 一页结论

| 问题 | 实测结论 | 处置 |
|---|---|---|
| 升级为何要下 185 MB？ | APK 185.8 MB 中 `rootfs-arm64-v8a.tar.xz` 占 **170.4 MB（91.7%）** | P1/P2 分层 + per-file 分块 |
| 能否对 tar.xz 直接做差分？ | rc.3/rc.5 两版 `tar.xz`：4 KB 块重合 **0.09%**、64 KB 块重合 **0%** | **不能**；必须未压缩分块 |
| 解包 106 s 卡在哪？ | `xz -dc` 全量解压 **11.7 s**、顺序写 1.2 GB **12.7 s** → CPU 占 11% | 瓶颈是 **75,624 个文件的逐文件创建** |
| 换 zstd 能快多少？ | 最多 106 → 97 s（-8%），且 tar 体积 +15~20% | **降级为可选** |
| 真正能省多少下载？ | 新增 **0** 文件 / 修改 **390** 个 / 内容相同 **90.60%**；其中 **100.38 MB** 是 apt 缓存 → 真实差异 **6.67 MB** | P2 目标 185 MB → **~7 MB** |

---

## 1. 实测基线（同一台设备）

```text
tar 条目总计        83,724
  opt/dsh           73,742 条目（88%）  694.1 MB（57%）
  usr                8,807 条目（10%）  340.2 MB（28%）
  var                  719 条目（1%）   104.3 MB（9%，其中 100.38 MB 是 apt pkgcache）
  etc                  436 条目          0.4 MB
文件数（仅普通文件） 75,624
APK 185.8 MB / 解压总 194.7 MB / rootfs.tar.xz 170.4 MB
首启（含重解）engine.ready 161,994 ms；纯冷启 65,818 ms；设备解包阶段 ~106 s
```

## 2. 阶段计划

| 阶段 | 动作 | 预期收益 | 判据 | 回退 |
|---|---|---|---|---|
| **P-1** ✅ | prune 补删 `var/cache/apt/{pkgcache,srcpkgcache}.bin` | rootfs/APK 各 **-22 MB** | 构建后 tar.xz 体积下降；设备无异常 | 删两行 revert |
| **P0** ✅ | `RootfsInstaller.ensureLocked` 三段日志（copy / sha256 / extract） | 启动链可分段度量 | 日志出现 `stage copy:`/`stage sha256:`/`stage extract:` | 删 6 行 revert |
| **P1** | rootfs 拆两层：`base`（usr+etc+var，345 MB / 9.9k 条目） + `engine`（opt/dsh，694 MB / 73.7k 条目）；manifest 改 `layers[]` | 引擎升级只动 engine 层 | `verify.py` 校验两层；设备只重解变化层 | manifest 回 `rootfs{}` |
| **P2** | engine 层 **per-file 内容寻址**（每文件一 chunk，sha256 索引 + 独立 zstd 块） | 升级下载 **185 MB → ~7 MB** | 只改一个文件时，下载量 ≈ 该文件大小 | 退回整层下载 |
| **P3** ✅（实测 -9.6%，未达预期） | 构建期切分片（base / engine，可再切 4 片），运行期并行解 N 个归档 | 首启解包 **106 s → 30–45 s** | `stage extract` 日志下降 | 退单包 |
| **P3-bis** ✅ | prune 删 `.d.ts`(16,196/51.3 MB) 与 `src/**/*.ts`(12,147/115.3 MB) —— 条目 -37% | 解包 77.4 s → 目标 ≤50 s | `stage extract(parts=4)` 下降 | 回滚两行 find |
| **P4** | 抄 dsh-Go：`DirectLaunch.select(...)` — direct 可选、safe 强制 proot、失败写 `directFailed` 回退 | 冷启后半段 **66 s → 45–55 s**（待实测） | 两种路径都能 `engine.ready` | 固定 proot |
| **P5** | 自更新：`REQUEST_INSTALL_PACKAGES` + `FileProvider` + `PackageInstaller` + 分步引导；15 镜像探测（2.5 s / 256 KB 测速）+ Range 4 线程 + 断点 | 下载可用性/速度 | 断网重连续传成功；镜像全挂时回直连 | 关掉入口 |
| **P-7** ✅ | `deleteTree` 先 chmod、删除失败兜底（旧 rootfs 不再残留） | 无 `rootfs.old-*` 残留 | 日志无 `启动清扫失败` | — |
| **P6** | 双槽 rootfs（A/B）+ 空间预检 | 损坏秒回滚 | 手改 rootfs 后能回滚 | 单槽 |

## 3. 关键约束（改错不报错但真机炸）

1. **分层不得改 `launch.argv`**：它只有 `--rootfs={ROOTFS}` + 若干 `-b`，base/engine 解到同一 rootfs 的子目录即可。
2. **替换 `opt/dsh` 时引擎必须已停**（运行中替换 = EBUSY / 半截文件）。
3. **manifest 结构变更要同步 5 处**：`tools/runtime/build-runtime.sh`、`tools/runtime/verify.py`、`RootfsInstaller`、`sign-upgrade-apk.yml` 的 `dsh<ver>` 断言、`tools/provision-glibc-host.sh`。
4. **分块必须用内容寻址**（per-file sha），**不能用定长块**：定长块在插入/删除后会整体错位（实测 64 KB 定长块重合 0%）。
5. **单个 tar 流不可并行解**：`TarArchiveInputStream` 顺序读、`XZInputStream` 不可随机访问 → 并行解包必须构建期切分片。
6. **分层是一次性架构变更**：老用户要么整包重解 1.27 GB，要么客户端写单层→分层迁移。
7. **`runtimeVersion` 含 `runtime/patches` 全部文件 sha**：改 `pins.json` 就会让指纹变 → 设备必重解一次（数据不动）。

## 4. 与对照工程的关系（依据）

| 能力 | Operit | dsh-Go | 本项目采纳 |
|---|---|---|---|
| 增量更新 | `PatchUpdateInstaller`：patch 链（≤64 步）、6 线程、`RandomAccessFile` 拼装、`DigestOutputStream` 边拼边验 | 仅构建期 `runtime/locks/<ver>/package-lock.json` 锁依赖 | P2（改用 **per-file 分块**，因实测 xz 不可差分） |
| 多源下载 | `GithubReleaseUtil`：15 个镜像 + `probeMirrorUrls(2500ms)` + 256 KB 测速；`HttpMultiPartDownloader` Range 4–8 线程 | 无 | P5 |
| 启动加速 | 无专项 | `DirectLaunch`（loader + `--library-path` + `preload.mjs`）、`boot-cache.mjs`、`XZ_THREADS=4` | P3/P4（direct **可选 + 回退**，不取代 proot） |

## 5. 不做的事（已用数据否决）

- **APK 整包差分（bsdiff/xdelta）**：对重新生成的 `tar.xz` 命中率 0.09%，只对 12 MB 的 dex/资源有效 → 性价比不足。
- **xz → zstd 替换**：CPU 仅占解包 11%，且会让 tar 变大 → 只在 P1/P2 完成后若带宽成瓶颈再评估。

## 6. 验收清单（每个阶段）

```text
P-1 : rootfs.tar.xz 体积 170.4 → ~148 MB；设备首次启动日志无异常
P0  : app.log 出现 stage copy / stage sha256 / stage extract 三行
P1  : manifest.layers 含 base+engine；只改 engine 时 base 不解包
P2  : 单文件变更 → 下载量 ≈ 文件大小；sha256 校验通过
P3  : stage extract 耗时下降（目标 ≤45 s）
P4  : direct 与 proot 两种情况都能 engine.ready；safe 模式强制 proot
P5  : 断点续传 + 镜像择优可用；无 REQUEST_INSTALL_PACKAGES 时自更新入口隐藏
```

