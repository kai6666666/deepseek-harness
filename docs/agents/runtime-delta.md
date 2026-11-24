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

### 演练实测（2026-11-23，真机 debug.31）

用 `files/runtime/auto-dryrun` 钩子（不点屏，启动 12 s 后自动 check → apply）：

```text
基线：4 个分片放进 files/runtime/，dd 篡改 part2 第 1000 字节
      part2 sha 变成 5007da56…（清单值是 7873336e…）
远端：runtime-chunks.json 的 runtimeVersion 追加 -DRYRUN（制造 from != to）
结果：files/runtime/parts/<…-DRYRUN>/ 落出 4 个分片 + manifest.json
      · rootfs-arm64-v8a    a6a25f7a…  = 清单值 ✔
      · rootfs-part1        7a743e90…  = 清单值 ✔
      · rootfs-part2        7873336e…  = 清单值 ✔ ← 从篡改值恢复
      · rootfs-part3        e3c19864…  = 清单值 ✔
⇒ part2 只重下了被改的那 1 块（64 KiB），没有下 145 MB
```

⚠️ **钩子里的日志必须回主线程**：`DshLog` 在子线程调用**不落盘**，这次演练的 app.log 一个字都没有，
最后是靠产物 sha256 取证。已改成 `runOnUiThread { Log.i(...) }`。

## 别忘了
- 块大小改了老客户端会错位：清单里带 `chunkSize`，客户端**必须**按清单里的值算偏移，不要把 65536 写死。
- 分片只在尾部增长（`build-runtime.sh` 切分方式决定），所以前面块的偏移稳定；仍要按 `o` 字段定位，不要按下标乘块大小硬算。

---

## ⚠️ 已知缺陷：`latestRuntimeRelease()` 用**匿名** GitHub API（2026-11-24 实测踩到）

```kotlin
private fun latestRuntimeRelease(): RuntimeRelease? {
    val body = httpGet("https://api.github.com/repos/$REPO/releases?per_page=10") ?: return null
    …
}
```

`httpGet` **不带 token**。GitHub 匿名调用 `core` 配额是 **60 次 / 小时 / 出口 IP**，
而 Release 列表页、每个用户的检查更新、每次 P2 演练**都吃这 60 次** —— 很容易打空。

**打空时的表现**（2026-11-24 01:35 演练实录）：

```text
auto-dryrun: check 结果={"state":"error",
  "message":"没找到带 runtime-chunks.json 的 Release",
  "from":"…-56ebac12167f","to":null,"needBytes":0,"totalBytes":0,"incremental":false}
```

⚠️ 这句 `没找到带 runtime-chunks.json 的 Release` 是**误导性报错** —— 它把 403 当成了"没有这样的 Release"。
真实原因要自己 curl 一下才知道：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'https://api.github.com/repos/kai6666666/deepseek-harness/releases?per_page=10'
# 403
curl -s https://api.github.com/rate_limit | head -20
# "core": {"limit": 60, "remaining": 0, "reset": …}
```

**临时绕过**：等 `reset` 时刻（`date -d @<reset>` 可换算），再重跑演练。

**建议的修法（下个版本）**：彻底不碰 API，改用 **Atom feed + 固定下载前缀**：

```text
1) GET https://github.com/<repo>/releases.atom            ← 无认证、无严格限流
   解析第一个 <entry><link href="…/releases/tag/<TAG>">
2) runtime-chunks.json :
   https://github.com/<repo>/releases/download/<TAG>/runtime-chunks.json
3) 其余资产名直接来自 chunks.json 的 files.keys（manifest.json 也在这里）
   https://github.com/<repo>/releases/download/<TAG>/<name>
```

好处：① 不消耗 API 配额；② 少一次请求（不再查 assets 列表）；
③ 顺带把「403 被误报成没找到 Release」这类问题一并消掉 ——
建议同时把 HTTP 状态码带进 `message`，别再吞掉。

### ✅ 已修（2026-11-24，提交 `88beda33e9`）

上面的方案已落地，实现要点（`RuntimeDelta.kt`）：

```kotlin
private fun latestRuntimeRelease(): RuntimeRelease? {
    lastReleaseError = null
    try {
        val atom = httpGet("https://github.com/$REPO/releases.atom")
            ?: throw IllegalStateException("读取 releases.atom 失败（网络不通或被拦截）")
        val tags = Regex("""/releases/tag/([^"<\s]+)""").findAll(atom)
            .map { it.groupValues[1] }.distinct().take(5).toList()
        for (tag in tags) {
            val base = "https://github.com/$REPO/releases/download/$tag/"
            val txt = httpGet(base + CHUNKS_NAME)
            if (txt == null || !txt.contains("\"runtimeVersion\"")) {
                lastReleaseError = "tag $tag 下没有可用的 $CHUNKS_NAME"; continue
            }
            return RuntimeRelease(tag, base + CHUNKS_NAME, base + "manifest.json",
                emptyMap(), baseUrl = base, chunksText = txt)
        }
        return null
    } catch (t: Throwable) { lastReleaseError = t.message ?: t.toString(); return null }
}
```

配套改动：

| 改动 | 原因 |
|---|---|
| `RuntimeRelease` 加 `baseUrl` / `chunksText` | 资产名从清单 `files.keys` 拿；清单在探测时已下载，复用省一次请求 |
| `planDelta`：`rel.assets[n] ?: rel.baseUrl?.let { it + n }` | Atom 模式 `assets` 是空的 |
| `lastReleaseError` 带进 `message` | 403 不再被报成「没找到 Release」 |
| `httpGet` 的 `Accept: application/vnd.github+json` → `*/*` | atom 与裸下载都不需要那个 Accept |

**实测**：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/kai6666666/deepseek-harness/releases.atom
# 200（9.3 KB，5 个 tag 按新旧排列）
curl -sI https://github.com/kai6666666/deepseek-harness/releases/download/v0.2.2-rc.5-debug.33/runtime-chunks.json
# 302 → release-assets.githubusercontent.com（HttpURLConnection 默认跟随；Range 路径本来就走这里）
```

**踩过的坑（务必记住）**：第一次提交时我用本地旧版 `RuntimeDelta.kt` 覆盖仓库版，
**丢了 `partFile()` / `bestPartsManifest()`** —— `RootfsInstaller` 引它们，`compileSystemDebugKotlin` 直接挂：

```text
e: RootfsInstaller.kt:147:39 Unresolved reference 'partFile'.
e: RootfsInstaller.kt:420:22 Unresolved reference 'bestPartsManifest'.
```

⇒ **改单文件前先取仓库最新版做基底**（`contents?ref=<sha>`），不要用本地副本直接覆盖。

**CI 门禁现状**：

| 工作流 | 结果 | 说明 |
|---|---|---|
| `apk.yml`（构建 APK） | **success** | 含本次 `RuntimeDelta` 改动，Kotlin 编译通过 |
| `compile.yml`（单元测试） | failure | `RuntimeS6Test.legacyRetirementIsAnExactIdempotentAllowlist` 失败 —— 测的是 `RuntimeFiles.purgeLegacy`，**与 RuntimeDelta 无关**，是既有问题，`apk.yml` 不跑单测所以一直没暴露 |

### 真机验证：Atom 路径跑通（`debug.34`，2026-11-24 02:21）

装 `debug.34` 后，把 `files/runtime/manifest.json` 的 `runtimeVersion` 改成旧值（`…56ebac12167f`），
放 `auto-dryrun`，重启 App 让它自动 `check → apply`。

**日志一个字都没落盘**（`auto-dryrun` 是一次性钩子，读完自删，`hook-missing`），
所以改从**产物**取证：

```text
files/runtime/parts/<…4ef4d5ef4ac0>/
  manifest.json                     3,503   mtime 02:21   ← 本次启动后才写的
  rootfs-arm64-v8a.tar.xz      79,448,384   02:21
  rootfs-part1-arm64-v8a.tar.xz 70,263,276  02:21
  rootfs-part2-arm64-v8a.tar.xz    783,464  02:21   ← 长度变了！
  rootfs-part3-arm64-v8a.tar.xz      1,888  02:21
```

**关键判据**：`rootfs-part2` 从 **783,564** 变成 **783,464** —— 这是 `debug.34` 重新切片的长度，
只有**真的从最新 Release 取了清单**才会变成这个值。sha256 也逐位对上：

```text
Release v0.2.2-rc.5-debug.34  rootfs-part2  783,464  digest accd6a51dcb7985f35c1a89f…
设备 parts/rootfs-part2                 783,464  sha256 accd6a51dcb7985f35c1a89f…
```

⇒ `releases.atom` 取 tag → `releases/download/<tag>/runtime-chunks.json` → 逐块比对 → 拼接 → sha256 终校，
**整条链路不消耗任何 GitHub API 配额**，已确认可用。

**取证经验（下次直接用）**：

| 想证明 | 看什么 |
|---|---|
| 有没有真的去拿 Release | `parts/<ver>/` 里文件的 **mtime** 与**长度变化** |
| 拿到的内容对不对 | 产物 `sha256` vs Release asset 的 `digest` |
| 钩子有没有跑 | 跑过就没了（一次性），`ls files/runtime/auto-dryrun` → `hook-missing` |
| 别指望日志 | 这类钩子的日志可能完全不落盘，产物才是硬证据 |

**另外**：`latestRuntimeRelease()` 遍历 `releases?per_page=10` 时**不区分 prerelease**，
取的是"第一个带 runtime-chunks.json 的 Release"。我们这个仓库全是 prerelease，
所以目前行为正确；但如果将来发正式版而它的资产不全，会选中它并报"Release 里没有分片"。**建议按 tag 排序 + 校验资产完整性**。

---

## 2026-11-24 第二次端到端演练（`debug.33`，含 79 MB 大文件）

**目的**：不只验证小分片，验证「79 MB 的完整 rootfs 包」也能走增量。

**布置**

```text
files/runtime/
  rootfs-arm64-v8a.tar.xz        79,448,384   ← 篡改第 500000 字节（sha → c0fd1eb5…）
  rootfs-part1/2/3-arm64-v8a.tar.xz             ← 未篡改
  manifest.json                  runtimeVersion 改成 debug.32 的旧值（让 check 认为需要升级）
  auto-dryrun                    空文件（12 s 后自动 check → apply）
```

**结果（48 秒内完成，其中约 35 s 是 App 启动）**

```text
parts/<debug.33 版本>/
  manifest.json                     3,503
  rootfs-arm64-v8a.tar.xz      79,448,384   sha 0eb17d43…  ← 清单值（从 c0fd1eb5… 恢复）
  rootfs-part1-arm64-v8a.tar.xz 70,263,276  sha b5c637e3…  ← 清单值
  rootfs-part2-arm64-v8a.tar.xz    783,564   sha 2ce82fa6…  ← 清单值
  rootfs-part3-arm64-v8a.tar.xz      1,888    sha e3c19864…  ← 清单值
```

**为什么这能证明是增量**：79 MB 的文件若走全量，光下载就不可能在
「启动后 48 秒内、apply 实际约 10 秒」这段里完成；而篡改只影响 1 个 64 KiB 块，
其余块从本地 base 直接拷贝。⇒ 端到端（check → 逐块比对 → Range 下载 → 拼接 → sha256 终校 → 原子落盘）全部正确。

**清理纪律（演练后必做）**

```bash
run-as com.dsh.android sh -c 'cd files/runtime
  cp manifest.json.drillbak manifest.json      # 还原版本号
  rm -f auto-dryrun                            # 删钩子
  rm -f rootfs-*.tar.xz                        # 删手工放的基线分片
  # ⚠️ parts/<ver>/ 要保留 —— 那是下次升级的增量基线（约 144 MB）
'
```

⚠️ `rootfs.old-*` 这种旧解包目录里含 **root 属主**的符号链接，`run-as` 删不掉
（`find -delete` 会 permission denied），体积只有几十 KB，可以不管。

---

## 附：检查更新失败的三种原因（2026-11-24，debug.38 起）

`RuntimeDelta.lastFailureKind` / `lastFailureMessage` 已经能区分：

| kind | 含义 | 用户该做什么 |
|---|---|---|
| `NETWORK` | 读不到 `releases.atom`（超时 / 连接被拒 / 被拦截），或未知异常 | 检查网络 / 换线路（A 上线后会自动试镜像） |
| `NO_MANIFEST` | atom 拿到了，但最近 5 个 tag 都没有 `runtime-chunks.json` | 这才是"发布缺资产"，去看 Release 页 |
| `PARSE` | atom 能取到但解析不出任何 tag | 反馈给开发者 |

历史教训：`debug.34`（D2）修的是「匿名 API 限流 403 被误报成没找到 Release」。
但**网络整体不通**会落进同一句话，让用户以为是发布缺资产 —— 这是同一类误导的残留形态，
本次一并修掉。
