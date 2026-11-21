# 引擎 0.2.2-rc.1 → 0.2.2-rc.3 升级预案（preflight）

> 本文是 [docs/agents/README.md](README.md) 的分册。
> 决策落点与 Gate 步骤见 [`engine-0.2.2-rc.3-plan.md`](engine-0.2.2-rc.3-plan.md)；本文只负责锚点与体积的实测数据。
> 写于 2026-11-17，基于**真机可复现的实测**：在 aarch64 Ubuntu 24 环境里
> `npm i @deepseek-ai/dsh@0.2.2-rc.3 --ignore-scripts` 后跑锚点核验。
> 与 [`engine-upgrade.md`](engine-upgrade.md) 的分工：那份是 bionic/`engine.bin` 时代的手册，
> 本文是 **PRoot 单运行时**（0.5.0 起）时代的 rc.3 预案。

---

## 0. 三个先记住的结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | `latest` 仍指向 **0.2.2-rc.1**，rc.3 只在 `next` 标签 | `npm view @deepseek-ai/dsh dist-tags` → `{"latest":"0.2.2-rc.1","next":"0.2.2-rc.3"}` |
| 2 | 装 rc.3 **必须显式写版本**，否则拉回 rc.1，升级静默无效 | 同上；`tools/engine-version.txt` 目前是 `0.2.2-rc.1` |
| 3 | 12 个补丁锚点里 **11 个仍命中，1 个失配**（发图格式白名单） | 见 §2 实测表。⚠️ **§2.2 的「唯一必改」结论已作废**：rc.3 已把该函数压缩成单行 `isImageMediaType`，`IMG_TYPE_GUARD` 与 `IMG_TYPE_ANCHOR` 必须**同时**重写，见 [`engine-0.2.2-rc.3-plan.md`](engine-0.2.2-rc.3-plan.md) §5.2 |

`docs/agents/engine-upgrade.md` §1 里出现的 “rc.3” 是 **0.2.1-rc.3** 的历史基线，
与本次 0.2.2-rc.3 同名不同物，不要照抄那一节的数据。

---

## 1. 目标版本事实（实测）

```text
@deepseek-ai/dsh@0.2.2-rc.3
  engines.node      >=24.9.0        （rootfs 现为 24.22.1，满足）
  tarball           6 MB / 532 files
  dependencies      91
  node_modules      1.2 GB（未裁剪，含全平台 prebuilds，338 个 @deepseek-ai 包）
  安装耗时          394 s（aarch64 Ubuntu，npmmirror，--ignore-scripts）
```

重包（裁剪候选，实测体积）：

| 包 | 体积 | 处理 |
|---|---|---|
| `@deepseek-ai/libreoffice-kit-wasm` | 146 MB | 默认删（手机端 Office→PDF 不用） |
| `sherpa-onnx-linux-arm64` | 39 MB | 默认删（本地 ASR/TTS） |
| `@deepseek-ai/dsh-experimental-inspector` | 29 MB | 默认删 |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | 23 MB | 保留（右侧栏文档预览是产品面） |
| `@deepseek-ai/dsh-web-frontend` | 21 MB | 保留（Web GUI 本体） |

---

## 2. 锚点核验（rc.3 实测）

### 2.1 基础 5 项 —— `tools/check-engine-anchors.mjs`，退出码 0

```text
✅ flock-platform        node-addon-system/lib/flock.js
✅ fail-loud-app-boot    dsh-app-boot/lib/index.js
✅ fail-loud-release     dsh/lib/profile-boot-QhDEDXsF.js   ← hash 名变了（rc.1 是 e2mS45fC）
✅ terminal-shell        dsh-terminal-bash/lib/index.js
✅ attachment-fsync      dsh-attachment-local/lib/index.js
```

### 2.2 扩展 7 项（替代 `engine-0.2.2-rc.1.md` 的 10 项清单）

| 锚点 | 常量 | rc.3 结果 | 命中位置 |
|---|---|---|---|
| `LLM_TOOLID` | `partial.toolCallId ?? brandString(...)` | ✅ | `dsh-llm/lib/index.js`、`lib/types/assembler.js` |
| `PICKER_START` | `const target = resolve(path ?? home);` | ✅ | `dsh-host-directory-picker-browse/lib/index.js` |
| `INSPECTOR` | `terminal inspection is unsupported on platform` | ✅ | `dsh-subprocess-local/lib/runner-launch-CKTiL8M8.js` |
| `PRESET_CORDIS_PERSONA` | `- id: persona` / `@deepseek-ai/dsh-persona` | ✅ | `dsh-web-app/presets/cordis.patch.yml:12` |
| `TOOL_ORDER` HEAD/TAIL | `return message.content.flatMap((block, index) => {` / `default: return unsupported(...)` | ✅ | `dsh-llm-deepseek/lib/index.js` |
| `PI_AI_TOOLID` START/END | `id: brandString(known?.id ?? ""),` / `id: brandString(event.toolCall.id),` | ✅ | `dsh-llm-pi-ai/lib/index.js` |
| **`IMG_TYPE`** | `return value === "image/png" \|\| ...` | ❌ **失配** | rc.3 已改写成紧凑模板字符串：`` `image/png`\|\|value===`image/jpeg`\|\|value===`image/webp`\|\|value===`image/gif` `` |

**必改项（修订）**：不是「只改 GUARD」，而是 **`IMG_TYPE_GUARD` 与 `IMG_TYPE_ANCHOR` 一起改**。

rc.3 已把该函数压缩成**单行、无缩进、反引号**形态，函数名也从匿名判断变成 `isImageMediaType`：

```js
function isImageMediaType(value){return value===`image/png`||value===`image/jpeg`||value===`image/webp`||value===`image/gif`}
```

现有 GUARD 带 `\t\t\t` 前缀与双引号，在 rc.3 上命中 **0 次**；`patchImageMediaType()` 会在 `if (!source.contains(IMG_TYPE_GUARD))` 处 `Log.w` 后**静默跳过**。新 GUARD / ANCHOR 的完整 Kotlin 写法见 [`engine-0.2.2-rc.3-plan.md`](engine-0.2.2-rc.3-plan.md) §5.2。

> 勘误：本文早期写过「`IMG_TYPE_ANCHOR` 引用了未定义标识符 `MEDIA_TYPE_TOKEN_RE`」。实测 `EngineManager.kt` 与 rc.3 的 `client.js` 中该标识符**各出现 0 次**，此说法不成立；真正的失配是「缩进 + 双引号」与「单行 + 反引号」的形状差异。

不改的症状与 0.4.x 那次一致：**发图静默失败**，日志不指向格式校验。

`runner-launch-<hash>.js` 已被 Kotlin 侧按 `startsWith("runner-launch-")` glob，hash 变化**不需要**改常量。

---

## 3. Gate 计划

### Gate 0 —— 锁版本（改 4 个单一真相源）

```bash
cd "/storage/emulated/0/MT2/apks/deepseek harness/deepseek-harness-0.2.2-rc.1"

# 1) 引擎版本（build-runtime.sh / provision-glibc-host.sh 都读它）
printf '0.2.2-rc.3\n' > tools/engine-version.txt

# 2) App 版本（versionName 对齐引擎，versionCode 必须严格递增：52 → 53）
cat tools/app-version.txt          # 先看现状再改
cat tools/mobile-ui-version.txt

# 3) CHANGELOG 顶部加小节（模板 docs/changelog/<versionName>.md）
```

判据：`sh tools/version.sh --check` → `---- VERSION PASS`。

### Gate 1 —— 锚点证伪（**先于任何打包**）

```bash
# 干净副本（不要在本机构建原生模块）
rm -rf /root/dsh-rc3 && mkdir -p /root/dsh-rc3 && cd /root/dsh-rc3
npm init -y >/dev/null
npm i @deepseek-ai/dsh@0.2.2-rc.3 --no-audit --no-fund --ignore-scripts \
  --registry=https://registry.npmmirror.com

# 基础 5 项
node "<repo>/tools/check-engine-anchors.mjs" /root/dsh-rc3
```

判据：`EXIT=0`（本文写时已实测 5/5）。
扩展 7 项按 §2.2 手工复核，`IMG_TYPE` 直接按新字符串改常量。

### Gate 2 —— 重建单运行时

```bash
cd "<repo>"
DSH_VERSION=0.2.2-rc.3 tools/runtime/build-runtime.sh
# 产物：_build/runtime/out/arm64-v8a/assets/runtime/rootfs-arm64-v8a.tar.xz
#       _build/runtime/out/arm64-v8a/assets/runtime/manifest.json
#       _build/runtime/out/arm64-v8a/jniLibs/arm64-v8a/*.so

python3 tools/runtime/verify.py \
  _build/runtime/out/arm64-v8a/assets/runtime/rootfs-arm64-v8a.tar.xz \
  _build/runtime/out/arm64-v8a/assets/runtime/manifest.json \
  _build/runtime/out/arm64-v8a/jniLibs/arm64-v8a
```

三条硬约束（来自 `tools/runtime/README.md`，踩过）：
1. 组装目录必须在 **ext4**（`/root/dsh-runtime-build`），`/sdcard` 是 FUSE，建不了符号链接；
2. 不要在 proot 里 `tar -x`，用 `extract.py` 逐条解，否则硬链接变 `.l2s.*` 链；
3. `libtalloc.so.2` 必须改名 `libtalloc.so` 并 `patchelf --replace-needed`。

判据：`---- RUNTIME PASS  n OK / 0 FAIL`；`dsh --version` 在 rootfs 内为 `0.2.2-rc.3`。

### Gate 3 —— 宿主 Kotlin 适配

| 位置 | 动作 |
|---|---|
| `IMG_TYPE_GUARD` | 换 rc.3 紧凑字符串（§2.2） |
| `REQUIRED_ENTRY_IDS` | **保持 4 项**，不要照抄官方 bundle 的 10 项（否则每次启动误判损坏→重解包→用户 `cordis.patch.yml` 被隔离） |
| `ensureNativeAddon()` | 仍要把 `require_builtin.node` 复制进 `build/napi/napi-v9-android-arm64/` |
| `LD_PRELOAD` | `files/liblinkcompat.so` 照旧（`link()` 仍被 SELinux 拦） |
| `DSH_PRIV_RUNNER` / `DSH_SHIZUKU_SOCKET` | 照旧注入，否则 `shell` / `root` **静默不注册**（只 WARN） |
| rootfs 版本戳 | 跟 `manifest.json` 走，`assetStamp` 必须与 `rootfs-arm64-v8a.tar.xz` 同版本 |
| `dsh-bridge/manifest.json` | 前端换了，gecko 的扩展 `version` 要 bump |

判据：`adb logcat -d -s DSH:I | grep -E "解包|引擎就绪|assetStamp"` 三行齐全；
`files/home/anchor-miss.json` 不存在。

### Gate 4 —— 移动端 UI 跟随 rc.3

rc.3 的 CSS Module hash 与 rc.1 全不同，插件靠「别名桥接」自动反推，但**必须重跑判据**：

```bash
adb shell am start -n com.dsh.android/.runtime.ProotProbeActivity \
  --es run_script /data/local/tmp/ui-regression-rc3.mjs
# 6 条：PREFLIGHT / D / R / F / E / G，退出码 0 = 全过
# ⚠️ 单运行时下 rootfs 的 node 是 glibc ELF，不能 run-as 裸跑；必须经上面这个 proot 探针。
```

手工判据（CDP 里数）：
- `document.styleSheets` 中 `[data-mobile]` 规则 ≈ **57**（0 = 插件 CSS 整体丢失，退回桌面布局）；
- `MP_LEGACY_HASHES` 里**不许**出现 rc.3 仍在用的 hash（先在
  `engine/node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js` 里搜 `<hash>_`）；
- 三处「更多」菜单（侧栏 / 会话视图 / 右侧栏）都要能开；右栏「创建你的插件」要收起右栏。

### Gate 5 —— 插件矩阵

```bash
# 1) 内置 10 个插件 + 7 个工具插件是否都在组合树里
dsh --profile web --dump-config | grep -E 'dsh-android-(mobile|shell|root|bubble|statusbar|uiagent|browser|pet|logs)'

# 2) 工具实跑（mock 驱动）
run-as com.dsh.android sh /data/local/tmp/mockrun.sh bubble '{"action":"get"}'
run-as com.dsh.android sh /data/local/tmp/mockrun.sh ui '{"action":"ping"}'
run-as com.dsh.android sh /data/local/tmp/mockrun.sh logs '{"action":"summary"}'
run-as com.dsh.android sh /data/local/tmp/mockrun.sh statusbar '{"action":"get"}'
run-as com.dsh.android sh /data/local/tmp/mockrun.sh browser '{"action":"tabs"}'
run-as com.dsh.android sh /data/local/tmp/mockrun.sh shell '{"command":"id"}'
```

判据：7/7 注册、6 实跑 `completed`；`root` 无 su 时记 `[SKIP]`。

`bundle/android` 的 `cordis.patch.yml` 要复核两个 id 在 rc.3 仍存在：
`session-query-sqlite`（`openAt: first-search`）、`plugin-manager`（镜像+官方双源回退）。

### Gate 6 —— 上机验收（一条命令）

```bash
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh --tools --llm --clean --latest
```

四条全绿才算出包：`verify-c.json` 的 `fail=0`、`engine.log` 无 `did not activate`、
`anchor-miss.json` 不存在、一轮真实对话能发出去（无 `SessionAlreadyOwnedError`）。
另加 `sh /data/local/tmp/verify-full.sh` → `---- FULL 4 PASS / 0 FAIL`。

### Gate 7 —— 发布与回滚

```bash
.\gradlew.bat :app:assembleDebug --console=plain        # system + gecko
sh tools/version.sh --check
python3 tools/verify-ci.py                             # ---- CI PASS  run=<id>
```

回滚：`assetStamp` 回旧值即触发重新解包（资产与戳必须同改，漏改是**静默**不生效）。
整包降级会被签名拦（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），需卸载清数据。

---

## 4. 版本戳清单（改资产就要改这里，漏改静默）

| 改了什么 | 必须改 |
|---|---|
| rootfs / 引擎 | `tools/engine-version.txt` + `assetStamp` + `manifest.json` |
| `mobile-ui.zip` | `EngineManager.MOBILE_UI_VERSION`（现 `1.1.0-185`）**且**重跑 `build-webview-compat.ps1` 的 `-CompatVersion` |
| `webview-compat.zip` | 换引擎后**必然**要重跑（`python3 tools/build-webview_compat.py --engine <dir>`） |
| `preset-razor.zip` | `PRESET_RAZOR_VERSION`（现 `1.0.3-1`） |
| `preset-skills.zip` | `PRESET_SKILLS_VERSION`（现 `1.0.0-3`） |
| `core-memory.zip` | `CORE_MEMORY_VERSION`（现 `1.0.0-2`） |
| `market-plugin.zip` | `MARKET_VERSION`（现 `1.0.0-6`） |
| `agnes-multimodal.zip` | `AGNES_MM_VERSION`（现 `1.0.0-4`） |
| pnpm | `PNPM_VERSION`（现 `11.28.5`，与 rc.3 的 `packageManager` 一致，无需动） |
| `dsh-bridge/content.js` | `app/src/gecko/assets/dsh-bridge/manifest.json` 的 `version`（现 `1.0.13`） |

---

## 5. 体积预算（已确认：Office Kit 保留）

> 本节数字为 preflight 初稿；**最终口径以 [`engine-0.2.2-rc.3-plan.md`](engine-0.2.2-rc.3-plan.md) §6 为准**。

rootfs 线（`tools/runtime/build-runtime.sh`）的裁剪点只有 `usr/include/node`、
`usr/share/{doc,man,info}`、`npm/docs`、pnpm 非 Linux 原生件、`python3.12/**/__pycache__`；
`PRUNE_LIST` 属 bionic 的 `build-engine-bin.sh`，**PRoot 线不读它**，引擎重包默认全保留。

| 项 | rc.1（实测） | rc.3-debug（预算） |
|---|---|---|
| `node_modules`（rootfs 内） | 386 MB | 1.1–1.2 GB（本次实测 1.2 GB） |
| rootfs 解包 | 997 MB | 约 1.7–1.9 GB |
| `rootfs-arm64-v8a.tar.xz` | 124 MB | **180–220 MB** |
| system debug APK | 186.9 MB | **240–300 MB** |

G2 出产物后 `ls -l` 一次即可把区间收敛成一个数。

---

## 6. 与 rc.3 官方升级指南的关系

rc.3 仓库的 `docs/upgrade-guide/` 只归档到 `v0.2.2-rc.1`（19 个条目），
**没有 rc.2 / rc.3 的迁移条目**。这意味着 rc.1→rc.3 的官方「破坏性变更清单」不存在，
只能靠本文 §2 的锚点证伪 + `docs/module-graph.zh.md` / `docs/tool-catalog.zh.md` 的差异比对兜住。
升级前把 rc.3 的 `tool-catalog.zh.md` 与自己 `--dump-config` 的工具清单做一次 diff，
是发现「工具改名/消失」最快的手段。
