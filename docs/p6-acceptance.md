# P6 收尾：引擎 0.2.2-alpha.2 → 0.2.2-rc.1 全量验收快照

设备：Xiaomi 25104RADAC / Android 16 / arm64-v8a / WebView 内核 156
应用：`com.dsh.android` · `versionName=0.4.3-debug` · `versionCode=48`
引擎：`@deepseek-ai/dsh@0.2.2-rc.1`（`.stamp = 0.2.2-rc.1-1`）
日期：2026-11-09

---

## 一、产物序列（P6 期间有效出包）

| 轮次 | 体积(B) | sha256（前 16） | 这一轮解决什么 |
|---|---|---|---|
| r17 | 186,100,875 | `3e55bdf6e2e62ac3` | node 入口包装（`bin/node` → wrapper + `node.real`），全新安装可自起 |
| r18 | 186,082,967 | `afaa472e581ccbd5` | 抽屉补丁迁入 `webview-polyfill.js` |
| r19 | 186,080,007 | `bab7f3f96b6415dd` | 补丁所有权收口：mobile-ui 回到纯净 `1.1.0-174` |
| r21 | 186,135,323 | `6a8cc9e4a18618a9` | 固定 debug keystore，`pm install -r` 可覆盖 |
| r22 | 186,072,915 | `01d3a50c473b323a` | 覆盖安装验证（不再卸载、不再搬 332 MB） |
| r23 | 186,110,387 | `cb63f042251865e3` | 解包目录替换三层退路（修 `无法将解包目录重命名`） |
| r24 | 186,133,135 | `e2879e8451007d6e` | `engine.staging-<stamp>-<pid>` 唯一化 + 过期残留清扫 |
| r25 | 186,057,423 | `7013001e0d0ab2a1` | 假救援修复（判据改 `超时兜底+HARNESS`）+ 12 s→20 s |
| **r26** | **186,071,371** | `2f235a75d4d81048` | 异步日志 1.5 s 兜底 flush（`web.log` 恢复落盘） |

当前装机：r26（`firstInstallTime=00:28:30` 全程未变，数据未丢）。

## 二、源码改动清单（13 处 + 通道）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `EngineManager.kt` | 解包三层退路：硬删复查 → `engine.old-<ts>` 挪开 → `copyTree()` 兜底 |
| 2 | `EngineManager.kt` | `staging` 唯一化 + `sweepStaleStaging()`（30 分钟阈值） |
| 3 | `EngineManager.kt` | `webview-compat.zip` 缺失单独 catch，W → I |
| 4 | `MainActivity.kt` | 救援判据改 `超时兜底 + HARNESS`；`UI_READY_TIMEOUT_MS 12000 → 20000` |
| 5 | `LogStore.kt` | 异步档 1.5 s 时间兜底 flush |
| 6 | `app/build.gradle.kts` | `signingConfigs.debug` 指向 `tools/dsh-debug.keystore` |
| 7 | `app/src/main/assets/webview-polyfill.js` | 抽屉/模态/头部/多模态四段补丁的唯一所有者 |
| 8 | `mobile-ui-plugin/.../lib/client.js` | 首帧样本改名、`超时兜底` 携带当前正文、`UI_READY_MAX_WAIT_MS 9000 → 15000` |
| 9 | `tools/node-runtime-wrap.sh`（新增） | `bin/node` 包装：补 `usr`/`home` 链接、过滤 `--no-open` |
| 10 | `tools/verify-engine-upgrade.sh` | 开发环境只校验 required 组；会话上限 `VERIFY_SESSION_MAX`（默认 4） |
| 11 | `tools/dsh-debug.keystore`（新增） | RSA 2048 / `androiddebugkey` / `android` / 10,000 天 |
| 12 | `.github/workflows/apk.yml` | node 包装步骤、版本对齐读 `bin/node.real`、`MOBILE_UI_VERSION 1.1.0-175` |
| 13 | `.github/workflows/ci.yml` | 密钥扫描放行公开 debug keystore |

## 三、验收矩阵

```text
[PASS] 引擎版本 0.2.2-rc.1
[PASS] 开发环境 nodejs 2/2 python 0/5 ssh 0/3 java 0/2 rust 0/2 go 0/1
[PASS] 会话索引干净（2/4 条）
[PASS] 引擎补丁标记 5/5 补丁标记命中
[PASS] 工具 bubble / ui / logs / statusbar / browser
[SKIP] 工具 root（冻结·待 root 环境）
----
9 PASS / 0 FAIL / 1 SKIP
json …/files/home/verify-20261109-025602.json
```

配套历史结论：

- 锚点门禁 13/13 PASS（引擎升级前冻结的基线）。
- `pm install -r` 连续 5 轮（r22→r26）覆盖成功，`firstInstallTime` 恒定。
- 冷启动路径：`引擎就绪 t+74 s`（首次解包）/ `t+15.9 s`（已解包），`http=401`，`crashes/` 无新记录。
- UI 五条缺陷全部真机复验：抽屉遮挡设置、左右按钮同一布局体系（`lead=[20,9.8,28,28]`、`dy=0`）、面板页左上不跳会话、标题留白、多模态双图标。

## 四、基线说明（不算回归）

| 项 | 说明 |
|---|---|
| 开发环境 python/ssh/java/rust/go 全 0 | 手机上只装 nodejs；判据已改为「只校验 `required` 组」 |
| 会话索引 2/4 | 用户自己就有 2 个会话；超 4 用 `VERIFY_SESSION_MAX=8` 抬上限 |
| 工具 root SKIP | 无 root 环境，冻结 |
| `webview-compat.zip` 未打包 | CI 无法产出降级前端；内核 156 不需要，日志已降为 I |
| `等待 Web 内核首帧超时，仍收起启动动画`（W） | `resetFirstFrameAwait()` 的另一个计时器，只影响动画收尾 |

## 五、复现命令

```sh
# 出包
curl -X POST -H "Authorization: token $T" -H 'Accept: application/vnd.github+json' \
  -d '{"ref":"release/0.4.3-debug"}' \
  https://api.github.com/repos/kai6666666/deepseek-harness/actions/workflows/apk.yml/dispatches

# 装机（数据保留）
cp dsh-0.4.3-debug-rNN.apk /data/local/tmp/r.apk
pm install -r -t /data/local/tmp/r.apk

# 门禁
run-as com.dsh.android sh /data/local/tmp/ve2.sh --tools

# 强制重解包（验证解包路径）
run-as com.dsh.android sh -c 'rm -f files/engine/.stamp'
am force-stop com.dsh.android; am start -n com.dsh.android/.MainActivity
```

## 六、证据索引（`_build/`）

| 文件 | 内容 |
|---|---|
| `p6-drawer-rootcause.md` | 抽屉遮挡设置的两条根因 + 探针证据 |
| `p6-header-align.md` | 左右按钮布局统一（1.1.0-171/172） |
| `p6-panel-fix-173.md` | 面板页左上按钮 / 标题留白（`syncLeadScope()`） |
| `verify-tools-fix.md` | `--tools` 的 `NO_FREE_PORT` 四层根因 |
| `polyfill-migration.md` / `single-owner-polyfill.md` | 补丁通道与所有权收口 |
| `stable-signing.md` | 固定 debug keystore |
| `engine-extract-fix.md` | 解包目录 rename 容错 |
| `engine-staging-unique.md` | staging 唯一化 + hygiene 放行 |
| `verify-gate-v2.md` | 门禁从 7/2/1 到 9/0/1 |
| `web-rescue-false-positive.md` / `web-rescue-fix-a.md` | 假救援根因与 A 案验收 |
| `logstore-flush.md` | `web.log` 停写根因与 1.5 s flush |
| `device/verify-engine-upgrade.v2.sh` | 门禁脚本（与仓库同源） |
| `apk/dsh-0.4.3-debug-r26.apk` | 当前装机产物 |