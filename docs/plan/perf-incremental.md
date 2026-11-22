# 计划：体积、启动与增量更新（rc.5 之后）

> 状态：**P-1 / P0 / P3 / P3-bis / P3-c 已实施**（`0.2.2-rc.5-debug.6` / vc91）；**P4-a 真机探针已通过**（见 §7）；P1 / P2 / P4-b·c / P5–P6 待批。
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
| **P3-c** ✅ | 解包进度改「增量累加」（每线程只加自己的 delta）+ 百分比单调夹逼 | 进度条不再 3X% ↔ 6X% | 真机进度单向递增 | 回滚 2 处 |
| **P4-a** ✅ | 探针 6,514 ms（vs proot 32.6 s）；**vc92 已落 App**：`DirectLaunch.kt` + `ProotHost` direct 分支 + 25 s 回退 + `direct-failed-<runtime>`；**默认关**（`files/direct-enabled` 开关） | 启动段 −26 s | `engine.ready runtime=direct` 且 health=401；回退路径也能 ready | 删开关文件 |
| **P4-b** | 补 4 个 shim（paths / dns / processes / modules），只在缺的时候兜底 | bash 工具 / `/sdcard` / apt / uid2000 全通 | 四项冒烟 | 删 shim |
| **P4-c** | 默认开 direct；safe mode 强制 proot | 同 P4-a | 3 次冷启稳定 + 异常自动回退 | 关开关 |
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
P3-c: 进度条单向递增，不回头
P4-a: direct=on/off 都能 engine.ready，fallbackReason 有据
P4  : safe 模式强制 proot
P5  : 断点续传 + 镜像择优可用；无 REQUEST_INSTALL_PACKAGES 时自更新入口隐藏
```


---
## 7. P4 直启（免 proot）真机探针 — 2026-11-22

设备：Xiaomi 25104RADAC / Android 16 (API 36) / arm64-v8a；rootfs `files/runtime/rootfs`。

### 7.1 结论（三项均实测）
```text
① loader 能拉起 node         : ld-linux-aarch64.so.1 --library-path … node → PROBE_OK（不是 cannot execute）
② 引擎能跑                   : … bin.js --version → 0.2.2-rc.5（exit 0）
   （注：Android16 的 seccomp 只对 x86_64 杀 loader；arm64 放行）
③ dsh web 能监听             : dsh web: http://127.0.0.1:46991/?token=… → HTTP 401（健康语义同 proot）
```

### 7.2 收益（同口径：从「extract 完成」到「`dsh web:` 打印」）
| 方式 | 耗时 | 备注 |
|---|---|---|
| proot（vc91 实测） | **32.6 s** | 18:15:59.287 extract done → 18:16:31.897 `dsh web:` |
| direct（探针实测） | **6.5 s** | `T0…880` → `T…394` = 6,514 ms |
| **净省** | **≈26.1 s** | 93.6 s 冷启 → 约 67 s |

### 7.3 direct 必需的环境垫片（缺一个就起不来）
```text
HOME           = $RF/root                         ← 引擎读 ~/.dsh
DSH_HOME       = <隔离目录>                        ← 避免污染真实会话
TMPDIR/TMP/TEMP= $RF/tmp                           ← 缺它 spill-local 直接 EACCES（mkdtemp /tmp 不存在）
PATH           = $RF/usr/local/bin:$RF/usr/bin:$RF/bin:…   ← 子进程（bash）靠它
NODE_PATH      = $RF/opt/dsh/node_modules
SSL_CERT_FILE  = $RF/etc/ssl/certs/ca-certificates.crt     ← 不设则 https 全失败
TZ/LANG        = Asia/Shanghai / C.UTF-8
cwd            = $RF/root
argv           = ld-linux --library-path <4 条> node <rootfs>/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
```

### 7.4 还没解决（P4-b 要做的）
| 坑 | 现象 | 对策 |
|---|---|---|
| 路径变物理长路径 | 引擎看到 `/data/user/0/…/rootfs/opt/dsh`，不是 `/opt/dsh` | 移植 dsh-Go `runtime/direct/paths.mjs`（toHost/toGuest + mounts） |
| `/tmp`、`/dev`、`/proc` 不翻译 | 已用 `TMPDIR` 绕过 tmp；`/proc` 读宿主（更真）但工具输出不一致 | `paths.mjs` + `processes.mjs` |
| 工具（bash）内的绝对路径 | `ls /opt/dsh` 指向宿主根 | 同上；或 `proot` 保留为工具通道 |
| hard link / `.l2s` | 本工程不用 l2s，暂不触发 | 沿用 dsh-Go 的 `compatibilityReason()` 空目录检测 |

### 7.5 复现
```text
sh tools/direct-probe/run.sh <package-files-dir> [port]
# 例：sh tools/direct-probe/run.sh /data/user/0/com.dsh.android/files 46991
```
探针**不碰 App 数据**（DSH_HOME 指向隔离目录），不影响 proot 启动。

### 7.6 ⚠️ 真机落地撞到硬墙：App 进程无权 execve app data 里的 loader（vc92/vc93 实测）
```text
Cannot run program "…/files/runtime/rootfs/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"
  (in directory "…/rootfs/root"): error=13, Permission denied
```
- **探针能跑、App 不能跑**：同一 uid（u0_a643）、同一台机、同一个 loader。
  探针跑在 `run-as`（adb 侧）的域，App 跑在 `untrusted_app`——**Android 10+ 不允许 untrusted_app
execve app data 目录里的文件**（只给 `nativeLibraryDir`/`apk_data_file` 的 execute 权限）。
- 已排除的次要因素：rootfs=`700 u0_a643`、`root/`=`755`、`tmp/`=`777`、loader=`755`，`canExecute()` 全为真。
- 所以 `DirectLaunch.unavailable()` 的 `canExecute()` **不足以判定可直启**：它只读 mode，读不到 SELinux。

#### 唯一可行路线（P4-a′，待做）
| 步 | 做法 | 依据 |
|---|---|---|
| 1 | 把 `ld-linux-aarch64.so.1`（203 KB）作为 **jniLib** 打进 APK：`libld-linux.so` | 只有 `nativeLibraryDir` 保证 `execute` |
| 2 | direct argv 改用 `nativeLibraryDir/libld-linux.so --library-path <rootfs libs> <rootfs>/usr/bin/node …` | loader 是**解释器**：内核只 execve loader，node 由它 mmap 加载，**不再触发对 node 的 execve 检查** |
| 3 | node 仍留 rootfs（123 MB 不进 APK），`unavailable()` 改判 loader 改成“jniLib 存在” | 体积不变 |
| 4 | 若 jniLib loader 也被拒，则 P4 在非 root 机型上只能放弃（保留 proot） | — |

> 记账：`vc92`/`vc93` 的 direct 路径现在**恒不可用**（`files/direct-enabled` 一开就 EACCES，随后回退/失败）。
> 开关默认关，所以对用户零影响；但 **P4-a 不能算完成**，要等 P4-a′ 用 jniLib loader 真机验过。

### 7.7 第三条硬墙：**glibc 的依赖库也不在可执行位置**（vc94/vc95 真机）
把 loader 换成 `nativeLibraryDir/libld-linux.so` 后，exec **通过了**：
```text
direct.spawn pid=? argv0=/data/app/~~…/lib/arm64/libld-linux.so      ← 路径正确
direct 未就绪（alive=false, 2 ms）                                    ← loader 自己秒退
```
- 为什么秒退：loader 接下来要 mmap `rootfs/usr/lib/**/libc.so.6` 等 glibc 运行时，
  而它们在 `app_data_file` 里 —— **`untrusted_app` 对 `app_data_file` 只有 read，没有 execute**，
  `mmap(PROT_EXEC)` 被拒 → 进程当场死、stderr 一个字都没有。
- 也就是说：**整套 glibc 运行时都得进 jniLibs**，而且要像 proot 当年那样用
  `patch-dynstr.py` 等长改写 `DT_NEEDED`（`libc.so.6` → `libc.so`），因为系统只抽取 `lib*.so`。
  实测代价：`libc.so.6 / libm / libpthread / libdl / libgcc_s / libstdc++ / libresolv / librt …` 十余个库
  + 每版维护。

#### P4 的净结论（三条路都验过）
| 方案 | 结果 |
|---|---|
| rootfs 里的 loader | ❌ error=13（SELinux untrusted_app） |
| jniLib loader + rootfs 的 glibc 库 | ❌ loader 秒退（依赖库无 execute） |
| jniLib loader + **整套 glibc 进 jniLibs + dynstr 补丁** | 未做；成本 ≈ 再造一个 proot 级工程 |

→ **收益 26 s（93.6 s → 约 67 s），但第 3 条路的工作量与长期维护成本远超一次性能优化**。
建议：**P4 冻结在探针结论**（数据留档），把预算转向 **P1 分层 + P2 分块差分（185 MB → ~7 MB）**。

---
## 8. 决策记录
| 日期 | 决策 | 依据 |
|---|---|---|
| 2026-11-22 | **P4（免 proot 直启）冻结**，不做「整套 glibc 进 jniLibs + dynstr 补丁」 | §7.6/§7.7 三条路真机验完；收益 26 s vs 成本≈再造 proot 级工程 |
| 2026-11-22 | 主线转向 **P1 分层 + P2 分块差分**（升级包 185 MB → ~7 MB） | §0 一页结论里真实差异仅 6.67 MB |
| 2026-11-23 | **P1-a：manifest 增 `layers[]`**（语义层名映射到现有 4 片）；P2 从「块级」改为「文件级增量」优先 | §9.1 现状：分片与并行解已存在；§9.4 改动以静态资源为主 |
| 2026-11-23 | **P1-b（插件资产迁 runtime、UI 热更新）列为下一候选**，待决策 B1/B2/B3 | §9.3：`mobile-ui` 在 APK assets 里，改一行 CSS 就要重装 161 MB |

---

## 9. P1 分层：现状勘察与落地拆解（2026-11-23）

### 9.1 现状（比计划里假设的更靠前）

| 事实 | 位置 |
|---|---|
| rootfs **已经按顶层目录切成 4 片**：`rootfs-arm64-v8a.tar.xz`(=./opt)、`part1`(./usr)、`part2`(./var ./etc)、`part3`(其余) | `tools/runtime/build-runtime.sh:405-423` |
| manifest 已有 `rootfsParts[]`（asset/sha256/bytes） | 同上 `:430-435` |
| 客户端已支持多片并行解 + 进度单调（vc91 修的就是这里的进度 bug） | `RootfsInstaller.installParts` |
| 客户端解析用 `optJSONArray/optJSONObject` → **新增字段不会弄坏旧客户端** | `RuntimeManifest.parse` |

→ P1 不是「从零切层」，而是**给现有 4 片贴上语义层名**，再让「只换一层」成为可能。

### 9.2 P1-a（零风险，先做）

`manifest.json` 增 `layers[]`，**纯增量、不新增文件、不改现有字段**：

```json
"layers": [
  {"name":"base","paths":["./usr","./lib","./lib64","./bin","./etc","./var","./sbin"],
   "parts":["rootfs-part1-<abi>.tar.xz","rootfs-part2-<abi>.tar.xz","rootfs-part3-<abi>.tar.xz"]},
  {"name":"engine","paths":["./opt"],
   "parts":["rootfs-<abi>.tar.xz"]}
]
```

- 落点：`build-runtime.sh:439` 的 python heredoc（多传一个 `LAYERS_JSON`，写法与 `PARTS_JSON` 完全一致）。
- 消费方：客户端后续版本按 `layers[].parts[].sha256` 决定「哪层变了只解哪层」。
- **代价**：改 `build-runtime.sh` 会让 `INPUTS`（脚本自身 sha256）变 → `runtimeVersion` 变 → 下次 APK 首次启动会重新解 rootfs（968 MB）。所以这一步要与「必定重解」的版本合并，或等 P1-b 一起做。

### 9.3 P1-b（真正的痛点，建议优先于 P2）

**勘察发现（重要）**：`mobile-ui` 等插件资产现在打在 **APK 的 `assets/mobile-ui.zip`** 里，**不在 runtime 层**。
→ 结果就是这两天的实际体验：**改一行 CSS = 重装 161 MB APK**（vc96 → vc104 每一版都是这样走的）。

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| **B1** | `mobile-ui.zip` 同时打进 runtime 资产（`plugins-mobile-ui-<ver>.zip`），客户端**优先 runtime、失败回退 assets** | 插件/UI 改动只需推 runtime 资产，**不装 APK** | 插件加载路径改动；加载失败会白屏（必须有回退兜底 + 真机验） |
| B2 | 只做「插件版本号 + 下载引导」：检测到新插件就提示去下 APK | 零风险 | 仍要装 APK，收益小 |
| B3 | 不做，UI 改动继续整包 | 零风险 | 每轮 161 MB |

### 9.4 P2 分块差分：方案修正

原计划是 rsync 式**块级**差分（文件内部改动）。实测改动以**静态资源/JS** 为主，块级收益不如**文件级**：

- **P2（改后）**：按 `layers[]` 做**文件级增量包** —— 比对旧/新层的文件 sha256，只打变化的文件（xz 打包），客户端解到对应层。
- 块级差分（弱校验 adler32 + 强校验 sha256）留给「单个大二进制内部微改」（node / proot），作为 P2-b 可选。
- 可继续用现有底数：真实差异 **6.67 MB** vs 整包 185 MB。

---
