# 0.2.2-alpha.2 适配清单（可直接照做）

> 这一页只装**结论与操作**；每一步的现场证据、失败过程与日志在
> [`engine-0.2.2.md`](./engine-0.2.2.md)（过程记录）。
> 版本基线：`@deepseek-ai/dsh@0.2.2-alpha.2`，引擎包 54,100 文件 / 430,317,442 字节。

---

## 0. 一条命令验收

```bash
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh          # 引擎版本 + dev-env + 会话索引 + 补丁标记
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh --ui     # 加装机 UI 断言（需前台+解锁）
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh --tools  # 加 mock 工具矩阵（约 3 分钟）
run-as com.dsh.android sh /data/local/tmp/verify-engine-upgrade.sh --json   # 只输出 JSON（含 --tools 时最有用）
```

脚本源在 `tools/verify-engine-upgrade.sh`；退出码即结论。`--json` 输出结构：

```json
{"ts":"2026-10-28T15:01:07.242Z","pass":4,"fail":0,
 "checks":[{"name":"引擎版本 0.2.2-alpha.2","pass":true,"detail":"…"}]}
```

每次运行还会落一份 `files/home/verify-<YYYYmmdd-HHMMSS>.json`，便于对比历史。

实测（2026-10-28）：

```text
[PASS] 引擎版本 0.2.2-alpha.2
[PASS] 开发环境 nodejs 2/2 python 5/5 ssh 3/3 java 2/2 rust 1/2 go 1/1
[PASS] 会话索引干净（2 条）
[PASS] 引擎补丁标记 5/5 补丁标记命中
[PASS] 工具 bubble
[PASS] 工具 ui
[PASS] 工具 logs
[PASS] 工具 statusbar
[PASS] 工具 browser
[PASS] 工具 root
----
10 PASS / 0 FAIL          ← --tools 全量，exit=0
```

`--tools` 依赖 `tools/mockrun.sh`（每次重启 mock 并等 `listening` 再起 headless）；`--ui` 段调用 `urc3.mjs`，额外打印 6 条断言逐行结果；`D` 段要求先建会话发一条消息，否则记 SKIP。

补丁标记 ≠ 锚点检查，两者分工：

| 检查 | 时机 | 对象 | 脚本 |
|---|---|---|---|
| `anchors` | 升级**前** | **未打补丁**的新引擎副本 | `tools/check-engine-anchors.mjs`（在 Ubuntu 侧跑） |
| `patch-marks` | 上机**后** | `files/engine`（已打补丁） | `tools/check-engine-patch-marks.mjs`（设备内跑，脚本已内置） |

前者回答「补丁还找得到原文吗」，后者回答「补丁真的写进去了吗」。5 个标记：flock 放行 android、app-boot 无 `proc.exit(1);`、profile-boot 有 `KEEP-ALIVE-RELEASE`、bash 走 `PREFIX`、attachment 容忍祖先目录。

---

## 1. 必改点（App 侧）

| # | 位置 | 改什么 | 不改会怎样 |
|---|---|---|---|
| 1 | `EngineManager.REQUIRED_ENTRY_IDS` | 保持 **4 项**，不要照抄官方 10 项 | 每次启动误判 bundle 损坏 → 重解包 → 用户 `cordis.patch.yml` 被隔离成 `.bak-<ts>` |
| 2 | `ensureNativeAddon()` | 把平台包的 `require_builtin.node` 再复制到 `build/napi/napi-v9-android-arm64/` | `MODULE_NOT_FOUND: require_builtin.node`，引擎起不来 |
| 3 | `MainActivity.assetStamp` | 跟 `engine.bin` 同版本（`0.2.2-alpha.2-1`） | 旧 stamp 不触发重新解包，跑的还是旧引擎 |
| 4 | 启动环境 | `LD_PRELOAD=files/liblinkcompat.so` | 会话落盘 `EACCES`（SELinux 不给 link） |
| 5 | 工具插件环境 | `DSH_PRIV_RUNNER` + `DSH_SHIZUKU_SOCKET` | `shell` / `root` **静默不注册**（只 WARN，不报错） |

## 2. 五个文本锚点（`node tools/check-engine-anchors.mjs`）

| 锚点 | 0.2.2 位置 | 结果 |
|---|---|---|
| `flock-platform` | `node-addon-system/lib/flock.js` | 5/5 通过 |
| `fail-loud-app-boot` | `profile-boot-*.js` | 同上 |
| `fail-loud-release` | `profile-boot-e2mS45fC.js`（hash 每版变，脚本按前缀扫） | 同上 |
| `terminal-shell` | 终端实现 | 同上 |
| `attachment-fsync` | 附件落盘 | 同上 |

## 3. 插件兼容

```text
10 个插件在 --dump-config 全部在
mobile client.js 被 served 446 KB
三处「更多」菜单：侧栏 / 会话视图 / 右侧栏
右栏「创建你的插件」→ 收起右栏；「浏览插件」→ 正常开插件页
```

## 4. 工具插件矩阵（mock 驱动实测）

| 工具 | 调用 | 结果 |
|---|---|---|
| `shell` | `{"command":"id"}` | completed · `uid=10603…`（headless 无 Shizuku binder） |
| `bubble` | `{"action":"get"}` | completed · 外观 JSON |
| `ui` | `{"action":"ping"}` | completed · 32 元素 / 394×806 |
| `logs` | `{"action":"summary"}` | completed · 718 条 / 警告 29 |
| `statusbar` | `{"action":"get"}` | completed · 配色 JSON |
| `browser` | `{"action":"tabs"}` | completed · 标签列表 |
| `root` | `{"command":"id"}` | completed · 无 su（通道已通） |

复跑：`run-as com.dsh.android sh /data/local/tmp/mockrun.sh <tool> '<json>' [mock4|mock5].patch.yml`

## 5. 验证矩阵（换代时逐条打勾）

| 判据 | 命令 | 0.2.2 实测 |
|---|---|---|
| 锚点 | `node tools/check-engine-anchors.mjs` | 5/5 |
| 装机 UI | `run-as … node /data/local/tmp/urc3.mjs` | 6 PASS / 0 FAIL |
| 开发环境 | `dsh-env.mjs status --json` | 6 组：2/2·5/5·3/3·2/2·1/2·1/1 |
| 工具插件 | `mockrun.sh` | 7/7 注册，6 实跑 |
| 对话 | 真实凭据 | 待补（当前 `API 密钥无效`） |

## 6. 回滚

```text
APK   /data/local/tmp/dshW2.apk（0.2.2 回滚包）
旧包  /sdcard/Download/dshci/nU（1.1.0-115）、nW（0.2.2）
方式  pm install -r -d dshW2.apk；assetStamp 回旧值即触发重新解包
```

## 7. 已知边界

- `root` 工具：设备无 su，命令不会执行（工具本身正常）。
- headless 手工跑：必须自己注入 5 个环境变量，App 启动时才有。
- `rust` 1/2：`rustup` unsupported，与 rc.3 一致，非 0.2.2 回归。
