# runtime 文件级增量（P2）

## 现状：升级要重下整个 runtime

`assets/runtime/` 是 4 个分片（`build-runtime.sh:405-423` 切好的）：

```text
rootfs-arm64-v8a.tar.xz         73,813,172 B
rootfs-part1-arm64-v8a.tar.xz   70,263,236 B
rootfs-part2-arm64-v8a.tar.xz      783,204 B
rootfs-part3-arm64-v8a.tar.xz        1,888 B
                                 ─────────────
                                 144,861,500 B ≈ 138 MiB
```

只要引擎版本变一次，`RootfsInstaller` 就得把这 4 片全下再全解（968 MB）。

## 真机实测：两版之间往往只差几十字节

`debug.27` 与 `debug.28` 的 runtime：

| 分片 | debug.27 | debug.28 | 差异 |
|---|---|---|---|
| `rootfs-arm64-v8a.tar.xz` | 73,813,172 | 73,813,172 | 字节级相同 |
| `rootfs-part1-…` | 70,263,236 | 70,263,236 | 字节级相同 |
| `rootfs-part2-…` | 783,156 | 783,204 | **+48 B** |
| `rootfs-part3-…` | 1,888 | 1,888 | 字节级相同 |

⇒ 为了 48 字节，用户要下 145 MB。

## 工具：`tools/runtime-chunks.py`

```bash
python3 tools/runtime-chunks.py manifest <runtime目录> <输出.json>   # 切块清单
python3 tools/runtime-chunks.py diff <old.json> <new.json>          # 算需下载的块
python3 tools/runtime-chunks.py verify <manifest.json> <runtime目录> # 校验本地一致性
```

块大小 **64 KiB（固定，不要改）**。清单里同时记：整文件 `sha256`（重组后终校）、每块 `{o, l, h}`（偏移/长度/哈希）。

### 实测输出（debug.27 → debug.28，64 KiB 块）

```text
rootfs-arm64-v8a.tar.xz:          完全相同 → 0 B
rootfs-part1-arm64-v8a.tar.xz:    完全相同 → 0 B
rootfs-part2-arm64-v8a.tar.xz:    5/12 块变化 → 324,452 B
rootfs-part3-arm64-v8a.tar.xz:    完全相同 → 0 B
---
总计      144,861,500 B / 2213 块        （清单 281,421 B）
需下载    324,452 B / 5 块
节省      99.7760%  （144,537,048 B 不必下载）
```

同一组数据用 1 MiB 块：需下 783,204 B（省 99.4593%）—— 小分片被整块带走，反而更亏。**这也是选 64 KiB 的理由**：

| 块大小 | 需下载 | 清单大小 | 请求数 |
|---|---|---|---|
| 1 MiB | 783,204 B | ~20 KB | 1 |
| **64 KiB** | **324,452 B** | 281 KB | 5 |

## 客户端契约（下一步落地：`RuntimeDelta.kt`）

1. 读本地 `files/runtime/manifest.json` 的 `runtimeVersion`，与远端 `runtime-chunks.json` 的版本比较；相同则什么都不做。
2. 对每个分片：本地块哈希（按 64 KiB 现算）与远端清单比较，得到「需要下载的块」。
3. **只对变化的块**发 HTTP Range（`Range: bytes=<o>-<o+l-1>`），GitHub Release 资产支持 Range（302 后裸下载即可，**别带 Bearer**）。
4. 在 `.staging-<ver>/` 里按偏移拼装：变化块来自网络，其余块从本地旧文件 `copy_file_range`/`read+write` 拷。
5. 全部分片拼完 → `sha256` 终校 → 原子 `rename` 到 `files/runtime/rootfs`。
6. 任一步失败 → 保留旧 runtime，删 staging（和现有 `ensureMobileUi` 的双源回退同一套纪律）。

## CI（已落地，2026-11-23 / P3）

| 位置 | 做了什么 |
|---|---|
| `apk.yml` 「生成 runtime 分块清单（P3）」 | `python3 tools/runtime-chunks.py manifest app/src/main/assets/runtime dist-plugins/runtime-chunks.json` |
| `apk.yml` artifact `plugins-mobile-ui` | `path` 从 `dist-plugins/*.zip` 改成 `dist-plugins/*`（zip 与 json 一起进 artifact） |
| `publish-apk.yml` job `publish-plugins` | 把 `runtime-chunks.json` 一并 `gh release upload`；**旧 run 没有该文件时只 warning**，不让发布失败 |

Release 上的资产名固定 `runtime-chunks.json`；客户端按里层 `runtimeVersion` 判断要不要升级。

两层把关：

1. `runtime-chunks.py manifest` 在目录里找不到 `manifest.json`（拿不到 `runtimeVersion`）时**直接 exit 1**，CI 当场红 —— 缺版本的清单对客户端毫无意义。本地调试用 `--allow-missing-version`。
2. 不要去 `run: |` 里塞 heredoc 做校验：YAML block 的基线缩进会被原样喂给 Python，`<<'CHK'` 不会剥缩进，必然 `IndentationError`（这次真踩了）。把校验放进脚本本身。

## 客户端（已落地 2026-11-23 / vc114）

`app/src/main/java/com/dsh/android/runtime/RuntimeDelta.kt`：

- `check()`：拉 Release 的 `runtime-chunks.json` → 与本地 `runtime/manifest.json` 的 `runtimeVersion` 比较；
  不同则按 64 KiB 块比对本地旧分片，得出「需下载的块」。
- `apply()`：`RandomAccessFile` 预分配整文件 → 先把本地旧分片整体拷进去 → 逐块 `Range: bytes=off-off+len-1` 覆盖；
  **单块 sha256 → 整文件 sha256** 两道校验；落 `.staging-<ver>/` → 成功才 `rename` 到 `runtime/parts/<ver>/`。
- 没有本地旧分片时自动走全量，并把分片**保留**下来，下一次就能增量。
- `pruneOldParts` 只留最近 1 个版本（每版约 145 MB）。

桥三方法三层同构：`runtimeDeltaCheck` / `runtimeDeltaState` / `runtimeDeltaApply`。
`SystemWebHost` 里的白名单别忘（**漏一条页面拿到 undefined 且不报错**）。

真机：`debug.29` 装上后 `classes4/7.dex` 里能搜到 `runtimeDeltaCheck/State/Apply`，`classes5.dex` 里能搜到 `RuntimeDelta` 与 `runtime-chunks.json`。

### 还没接线的两处

1. `RootfsInstaller.installParts` 仍从 APK assets 拷分片 ⇒ 要加一层「`files/runtime/parts/<manifest.runtimeVersion>/<asset>` 存在且 sha 相符就直接用」，增量才能真正替掉「重装 161 MB APK」。
2. 前端「检查更新」弹窗还没有运行时那一行（`RuntimeDelta.stateJson` 已就绪，纯前端活）。

## 两个编译坑（这次真踩了）

1. **Kotlin 块注释支持嵌套**：KDoc 正文里写 ``runtime/parts/*/<asset>`` 会开一层新注释，于是 KDoc 自己的 `*/` 只关掉内层，编译器报的是「`Missing '}'` + `Unclosed comment`」，一行都指不到真凶。注释里别写裸 `/*`。
2. **`SystemWebHost.kt` 没有 import `android.webkit.JavascriptInterface`**，白名单里一律写全限定名 `@android.webkit.JavascriptInterface`。照抄相邻那行就不会错。

## 演练方法（可重跑）

1. 把**当前 APK** 里的 4 个分片拷到 `files/runtime/` 根 —— 它们充当比对基线（`localBase` 会先看这里）。
2. 篡改其中一个分片的 1 字节：`printf Z | dd of=files/runtime/rootfs-part2-arm64-v8a.tar.xz bs=1 seek=1000 conv=notrunc`。
3. 制造 `from != to`：把 Release 上 `runtime-chunks.json` 的 `runtimeVersion` 加个后缀（或只把本地 `runtime/manifest.json` 的版本改掉，但后者会让下次启动重解包）。
4. 设置 → 关于 → 检查更新 → 弹窗应出现「运行时 <短码>（增量 64 KB）」。
5. 立即更新 → 只下那 1 块 → `applied`（若只有运行时更新，提示「重启 App 生效」）。
6. **恢复**：删 `files/runtime/*.tar.xz`、回滚远端清单、删 `files/runtime/parts/*`。

### 2026-11-23 实测

- 算法复刻（同一份清单 + 篡改后的 part2）：part2 共 12 块，**1 块变化 = 65,536 B**；
  总计 144,861,292 B ⇒ **省 99.9548%**。
- 分片从 `/sdcard` 直接 `cp` 进 `files/runtime/` 会**静默失败**（App 侧 `cp` 读外置存储受限）：
  先 `cp` 到 `/data/local/tmp`，再 `run-as ... cp /data/local/tmp/...`（这是一路踩出来的）。

## 别忘了

- 块大小改了老客户端会错位：清单里带 `chunkSize`，客户端**必须**按清单里的值算偏移，不要把 65536 写死。
- 分片只在尾部增长（`build-runtime.sh` 切分方式决定），所以前面块的偏移稳定；仍要按 `o` 字段定位，不要按下标乘块大小硬算。
