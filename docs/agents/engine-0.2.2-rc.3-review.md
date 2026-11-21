# rc.3 升级计划审查报告（第二轮）

> 审查对象：[`engine-0.2.2-rc.3-plan.md`](engine-0.2.2-rc.3-plan.md) 第一版（321 行）。
> 审查方式：只读源码 + 在 Linux 侧跑真实命令（`version.sh`、`check-engine-anchors.mjs`、pin 结构 dump、rc.3 client.js 检索）。
> 审查时间：2026-11-18。**本轮未修改任何版本文件、workflow、代码常量，未构建、未装机、未发布。**
> 结论：第一版有 5 处**会导致失败或静默失效**的缺陷，已全部写进第二版；另有 10 项补充项。

---

## 1. 基线实测（审查开始时的真实状态）

| 项 | 命令 | 结果 |
|---|---|---|
| 版本同源 | `sh tools/version.sh --check` | `---- VERSION PASS app=0.2.2-rc.1 vc=52 engine=0.2.2-rc.1`，EXIT=0 |
| 基础锚点 | `node tools/check-engine-anchors.mjs /root/dsh-rc3` | 5/5 全 ✅，EXIT=0（`fail-loud-release` 命中 `profile-boot-QhDEDXsF.js`） |
| rc.3 引擎副本 | `/root/dsh-rc3` 的 `@deepseek-ai/dsh/package.json` | `0.2.2-rc.3`（可用于 G1，无需重装） |
| 补丁 pin | `runtime/patches/pins.json` | 6 个补丁，**每个只有 `0.2.2-rc.1`** |
| `IMG_TYPE_GUARD` | `EngineManager.kt:7391-7393` | 带 `\t\t\t` 前缀 + 双引号；在 rc.3 命中 **0** 次 |
| `MEDIA_TYPE_TOKEN_RE` | Kotlin 与 rc.3 client.js | 各 **0** 次（第一版「锚点引用未定义变量」不成立） |
| `.git` | 工作区根 | **不存在** |
| GitHub API | `GET /repos/kai6666666/deepseek-harness` | `401 Bad credentials`（另一次 `Read timed out`） |
| 旧运行时产物 | `../_build/runtime/out/**/manifest.json` | `runtimeVersion = r1-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5-03847695f40a` |
| 非文档文件基线 | 264 个文件整体 sha256 | `e3f0227209aceb95cbae98daafe100752819b46e178e6d4ead57ebeb7bb1bfbe` |

---

## 2. 第一版结论：证实 / 推翻

| 第一版说法 | 判定 | 依据 |
|---|---|---|
| `latest` 仍指 rc.1，rc.3 在 `next` | ✅ 证实 | preflight 实测 + 本轮 rc.3 副本版本核对 |
| 必须显式写 `@0.2.2-rc.3` | ✅ 证实 | `build-runtime.sh:281` 用变量拼版本 |
| `IMG_TYPE` 必改 | ✅ 证实（但理由错） | rc.3 已压缩为单行、反引号、函数名 `isImageMediaType`；失配原因是**缩进与引号形态**，不是「引用未定义变量」 |
| 只有 `IMG_TYPE` 一处要改 | ❌ 推翻 | `verify-engine-upgrade.sh:185` 断言、`apk.yml` 三处硬编码、`build-runtime.sh:38` 默认值、`pins.json` 缺版本、`make-patches.py` 覆盖写、验收脚本 bionic 路径、`verify-ci.py` 错误 workflow、`RuntimeFiles` 空间预算 —— 共 9 类 |
| 改 5 个文件 + 跑 3 条命令即可 | ❌ 推翻 | 单运行时下验收脚本连「跑起来」都做不到（glibc node 不能在 Android 裸执行） |
| `git checkout` 可回退 | ❌ 推翻 | 工作区无 `.git` |
| 补丁会自动重生成 | ⚠️ 半对 | 会生成，但**覆盖**掉 rc.1 pin（`make-patches.py:146-153`），且缺失版本只 SKIP 不失败 |

---

## 3. 阻塞项（B1–B9）与证据

| # | 缺陷 | 关键位置 | 证据 |
|---|---|---|---|
| B1 | pin 只有 rc.1，缺版本仅 SKIP | `apply-patches.py:39-41` | dump 显示每个补丁只有 `0.2.2-rc.1` 键；`SKIP` 不进 `bad` |
| B2 | 生成器整条覆盖 pin | `make-patches.py:146-153` | 源码是 `pins[...] = {ver: {...}}`，非 `setdefault` |
| B3 | 验收脚本走已不存在的 bionic 树 | `verify-engine-upgrade.sh:18,184,185,207`、`mockrun.sh:5,33,38`、`ui-regression-rc3.mjs:2` | 实际路径为 `files/runtime/rootfs`（`ProotHost.kt:26`）；rootfs 的 node 是 glibc ELF |
| B4 | CI `DSH_VERSION` 未注入 | `build-runtime.sh:38`、`apk.yml:76-82` | env 只有 4 个变量，默认值硬编码 rc.1 |
| B5 | 发布段硬编码 | `apk.yml:106,268,272,275-276` | `v-debug` / `0.5.0` / `rc.1` / `vc **51**` |
| B6 | `verify-ci.py` 查错 workflow | `verify-ci.py:25` | 查 `android-release.yml`，本轮走 `apk.yml` |
| B7 | 发布早于真机验收 | `apk.yml:260` | 仅挡 PR / 非 main，无人工闸门 |
| B8 | 双产物强制 | `publish-release-from-run.yml:42-44` | `test -n "$SYS" && test -n "$GECKO"` |
| B9 | 空间预检偏小 | `RuntimeFiles.kt:22` | 1350 MiB vs 峰值 2.9–3.1 GB |

### B3 的额外证据：为什么不能「只改路径」

```
rootfs 内：/usr/bin/node  → ELF（glibc，interp=/lib/ld-linux-aarch64.so.1）
Android 侧：/lib/ld-linux-aarch64.so.1 不存在
⇒ run-as sh -c 'files/runtime/rootfs/usr/bin/node x.mjs'  → ENOENT（报错指向加载器，不指向文件）
```

因此设备侧验收必须复用 App 的 proot 通道。`ProotProbeActivity` 已存在（debug 探针，`ProotHost` 同源 manifest），最小改动是给它加 `run_script` / `run_args` 两个入参，比新写一套 bridge 更省。

---

## 4. 补充项（M1–M10）

| # | 项 | 影响 |
|---|---|---|
| M1 | G1 必须早于 G2 | pin 未生成时全部 SKIP |
| M2 | 装机前备份 `home/.dsh` + `workspace` | 覆盖安装虽不清数据，但需兜底 |
| M3 | 无 `.git` ⇒ 文件级快照 | 回滚方案整体改写 |
| M4 | token 401 | G7/G8 无法进行 |
| M5 | Office 需真跑三件套 | 注册 ≠ 可用（原生 vs WASM 两条路） |
| M6 | UI 需保留坐标证据 | 防「脚本绿、肉眼坏」 |
| M7 | 首次解包 3–8 分钟 | 验收超时阈值必须放大 |
| M8 | 旧 `_build/runtime/out` 有 rc.1 产物 | 必须独立输出目录 |
| M9 | `PNPM_VERSION` 10.28.2 vs 11.28.5 | 与 rc.3 `packageManager` 可能不一致 |
| M10 | `version.sh` 连带校验断言与 4 个脚本默认值 | G0 不同改就 `VERSION FAIL` |

---

## 5. 文档层面的失真（本轮一并修正）

| 文件 | 失真 | 处理 |
|---|---|---|
| `docs/agents/README.md:26` | preflight 一句话写「锚点 11/12 命中、`IMG_TYPE` 必改」 | 改为「5/5 基础锚点 + 扩展项按 rc.3 压缩形态复核」 |
| `docs/agents/README.md:27` | plan 标「已确认」 | 改为「待执行批准」 |
| `docs/agents/engine-0.2.2-rc.3-preflight.md` §2.2 | 「唯一必改」结论 | 作废，改为「GUARD 与 ANCHOR 同改」 |
| `docs/agents/mobile-ui.md` / `mobile-ui-rc3.md` | 未记录 PR#9 的历史归属（grep `PR#9` 在正文 0 命中，仅在计划里出现） | 补历史状态说明：已在更早版本修复，本轮只回归；不归功于未发布的 `1.1.0-186` |

---

## 6. 本轮**没有**做的事

- 未改 `tools/*.txt`、`app/build.gradle.kts`、`EngineManager.kt`、`RuntimeFiles.kt`、`ProotProbeActivity.kt`
- 未改任何 `.github/workflows/*`
- 未改 `runtime/patches/pins.json`（它必须由 G1 在批准后生成）
- 未构建、未装包、未派发 CI、未建 tag / Release、未碰真机

---

## 7. 批准后第一屏该看到的输出

```text
---- VERSION PASS app=0.2.2-rc.3-debug vc=53 engine=0.2.2-rc.3
✅ flock-platform … （5/5）
guard_hits 1   token_re false
PINS OK   （6 个补丁 × 2 个版本键）
```

任一行不成立，不进 G2。
