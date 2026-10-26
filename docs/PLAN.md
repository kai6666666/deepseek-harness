# DSH Android 总计划（备查）

> 版本基线：引擎 `@deepseek-ai/dsh 0.2.1-rc.3`（宿主内可降级到 rc.2）· App `0.4.1`（versionCode 33）
> 本文是**唯一索引**：任何“我们打算做什么 / 做到哪了 / 怎么验 / 怎么退”都从这里查。
> 最后更新：2026-10-26

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 手机能不能跑官方 dsh？ | 能。引擎是纯 JS + 4 个原生模块，官方未改一行。 |
| 沙箱能不能做到内核级？ | **本机不能**。`CONFIG_USER_NS` / `CONFIG_SECURITY_LANDLOCK` 均未编入（实测），只能用户态拦截或换内核。 |
| 生态能不能全绿？ | **不能全绿**。ABI 层靠 proot(glibc) 解决；内核特性/浏览器引擎/GPU/桌面壳四类只能换宿主或加桥。 |
| 最优长期架构？ | 双轨：**proot(glibc) 引擎 + DSHAPP 原生壳**；能接受一台常开机器时用**远端引擎**（100% 保真）。 |
| 现在到哪了？ | 宿主抽象、glibc 适配（已编译+功能验证 9/9）、装配/验收脚本、MCP 桥（已跑通）、宿主切换接线、计划文档——全部落盘。 |

---

## 1. 目标与非目标

### 1.1 目标
1. **在 Android 上跑官方 DeepSeek Harness**，前端不重写、引擎不 fork。
2. 把 Android 独有能力（UI 自动化、Shizuku/root、通知、浏览器）**以桥的形式**供给模型。
3. 提供**可切换宿主**（bionic / proot-glibc / remote），失败自动回落，不把 App 变砖。
4. 每一条承诺都有**可执行验收**（脚本 + JSON 落盘 + 日志锚点）。
5. 升级引擎时，**适配与引擎解耦**（能用 profile/overlay 表达的不写锚点）。

### 1.2 非目标
- 不追求“在 bionic 上编出全部原生模块”（维护成本无上限）。
- 不用自研 agent loop 替代 dsh（会立刻脱离生态）。
- 不做 seccomp 自写“路径沙箱”（内核接口不支持，做出来是假边界）。
- 不承诺 PID 命名空间隔离（需换内核）。

---

## 2. 架构（四层 + 三桥）

```text
┌ UI 层 ──────────────────────────────────────────────┐
│ WebView / GeckoView  ← 官方前端（窄屏适配插件）        │
│ 设置页：宿主选择 / 能力声明 / 装配 / 验收              │
└───────────────┬─────────────────────────────────────┘
                │ PageBridge（JS 桥白名单，两份 flavor）
┌ 宿主层（Kotlin）──────────────────────────────────────┐
│ EngineHost 接口                                       │
│  ├ TermuxBionicHost（现状，自编译原生绑定）            │
│  ├ ProotGlbcHost（C 方案，glibc 预编译全解锁）         │
│  └ RemoteHost（引擎在别的机器）                        │
│ EngineBootGate：选择 + 失败回落 + 日志                 │
│ RootfsProvisioner / VerifyC：装配与验收                │
└───────────────┬─────────────────────────────────────┘
                │ 文件信箱 / MCP / provider 注册
┌ 引擎层 ──────────────────────────────────────────────┐
│ @deepseek-ai/dsh（未改）                              │
│  profile: web / rescue（+ 未来 android profile）       │
│  overlay: --patch（sandbox runner / session-query / registry）│
└───────────────┬─────────────────────────────────────┘
                │
┌ 运行时层 ────────────────────────────────────────────┐
│ bionic：Termux + node 26 + 自编译 flock/node-pty        │
│ glibc ：proot Ubuntu 24.04 + node 24 + 官方预编译        │
│ 原生适配：boo-sandbox-run / libboosandbox / liblinkcompat│
└──────────────────────────────────────────────────────┘
```

三桥：**L1 文件信箱**（已有）→ **L2 provider**（computer-use / browser-use）→ **L3 MCP**（`bridge/mcp-android`）→ **L4 卸载**（jobs/ssh/sdk/acp）。

---

## 3. 阶段计划

### P0 地基（已完成）
| # | 任务 | 交付 | 验收 |
|---|---|---|---|
| 0.1 | 引擎原封跑通 | Termux + node + dsh，官方前端 | `engine.log` 有 URL；无 `did not activate` |
| 0.2 | 12 处 Android 适配 | `EngineManager` 的 ensure/patch | 会话可写、图片可发、终端可开 |
| 0.3 | 沙箱 runner | `boo-sandbox-run` + `libboosandbox` | workspace 放行 / 外部拒绝 |
| 0.4 | link 转译 | `liblinkcompat` | `/sdcard` 与 app 私有目录写入不报 EACCES |

### P1 宿主化（本轮完成）
| # | 任务 | 交付 | 验收 |
|---|---|---|---|
| 1.1 | 宿主抽象 | `engine/EngineHost.kt` | 编译通过；能力枚举可读 |
| 1.2 | proot 宿主 | `ProotGlbcHost.kt` | 起得来、端口就绪、日志可诊断 |
| 1.3 | 启动闸门 | `EngineBootGate.kt` + `EngineManager.bootWithHost` | proot 失败回落 bionic，`degraded=true` |
| 1.4 | 装配 | `RootfsProvisioner.kt` + `provision-glibc-host.sh` | 8 项 preflight 全绿 |
| 1.5 | 验收 | `VerifyC.kt` + `verify-c.sh` | `verify-c.json` `fail=0` |
| 1.6 | glibc 补丁 | `apply-glibc-patches.py` | gcc 三产物编译通过；9/9 边界测试 |

### P2 桥（进行中）
| # | 任务 | 交付 | 验收 | 预估 |
|---|---|---|---|---|
| 2.1 | MCP 桥 | `bridge/mcp-android` + `McpBridge.kt` | `initialize`/`tools/list`/`tools/call` 往返 | ✅ 已完成 |
| 2.2 | 能力接线 | `McpWiring` + `PrivilegedRunner` | 六件套全通；shell/screenshot 走 uid2000，未授权时显式 `privileged:false` | ✅ 已完成（6/6） |
| 2.3 | computer-use provider | 插件注册 `ctx.computerUse` | 预设里出现 provider；工具可点屏 | 3–5 人日 |
| 2.4 | browser-use provider | 复用原生 WebView | 可登录站点截图 | 5 人日 |

### P3 对齐（下一阶段）
| # | 任务 | 说明 | 预估 |
|---|---|---|---|
| 3.1 | 引擎追平上游 | rc.3 已装并核对：**锚点 5/5 命中**；打包脚本产出 96 MB `engine.bin`；待上机验收 | 🟡 待上机 |
| 3.2 | 文本锚点 fail-loud | `AnchorAudit`：5 项锚点 → `anchor-miss.json` + 启动时通知（`McpWiring.notify`）；日志页/诊断包读同一文件 | ✅ 已完成 |
| 3.3 | 全文检索开启 | `writeSessionSearchPatch()`（overlay：落盘索引 + `openAt: first-search`） | ✅ 已完成 |
| 3.4 | Open In 支持 | `android_open_with`（MCP）：/sdcard 路径走 DocumentsUI chooser；app 私有目录明确报错；官方“Open In…”按钮仍不出现（它按 macOS/Win/Linux 目录解析） | ✅ 已完成（MCP 形态） |
| 3.5 | 自定义 android profile | `bundle/android` 骨架：package.json + cordis.patch.yml + 12 overlay 迁移表；收口（删重复 overlay）待上机验证后做 | 🟡 骨架完成 |

### P4 产品化（择机）
| # | 任务 | 说明 |
|---|---|---|
| 4.0 | **CI 出包** | `.github/workflows/apk.yml`（ubuntu-latest / x86_64）+ `tools/ci-fetch-assets.sh`；资产走 Release，缺资产降级出包。见 `docs/agents/ci-build.md` | ✅ 已跑通（run 40312131079，6.61 MB 无资产工件） |
| 4.1 | 远程引擎模式 | `--host` 绑具体 IP + `--trusted-host` + Tailscale/隧道 |
| 4.2 | AVF 路线 | Android 15 QPR2+/16 的 Linux Terminal，真内核沙箱 |
| 4.3 | 插件市场兼容标注 | 按“是否发布 linux-arm64-gnu”给出可安装性 |
| 4.4 | 诊断包增强 | 收 `provision.json` / `verify-c.json` / `anchor-miss.json` |

---

## 3.5 编译验证（新增门禁）

`engine/` 包可在无 Gradle 环境下独立类型检查（kotlinc + android.jar + coroutines）。
首次跑出 3 个“肉眼看不出、真机必炸”的错误（KDoc 里的 `*/` 提前闭合、`File.relativePath`、`Process.pid()`），已修。
完整命令与记录见 [docs/agents/verification.md](agents/verification.md)。

## 4. 代码地图（改哪查哪）

| 你要改什么 | 看这个 |
|---|---|
| 引擎启动流程 | `EngineManager.kt:6903 start()` / `bootWithHost()` |
| 宿主选择 | `engine/EngineHosts.kt`、`engine/EngineBootGate.kt` |
| proot 参数/绑定 | `engine/ProotGlbcHost.kt`、`docs/agents/proot-glibc-host.md` |
| 砂层 C 代码 | `app/src/main/jni/{boo-sandbox-run,boosandbox,linkcompat}.c` |
| glibc 补丁 | `tools/apply-glibc-patches.py` |
| 装配 | `tools/provision-glibc-host.sh` |
| 验收 | `tools/verify-c.sh`、`engine/VerifyC.kt` |
| MCP 桥 | `bridge/mcp-android/server.mjs`、`engine/McpBridge.kt` |
| 生态 20% 的解法 | `docs/agents/ecosystem-bridge.md` |
| 宿主切换接线 | `docs/agents/host-switch.md` |

---

## 5. 验收总表（一次跑完）

```bash
# 1) 装配（幂等）
sh $FILES/bin/provision-glibc-host.sh
# 2) 九项边界 + 预编译
sh $FILES/bin/verify-c.sh
# 3) 宿主切换后的日志锚点
adb logcat -d -s DSH:I | grep -E "宿主=|已写入宿主 overlay|启动 proot 宿主"
# 4) 结构化结果
cat $FILES/home/.dsh/logs/verify-c.json
cat $FILES/home/.dsh/logs/provision.json
```

**必须全绿的四条**：
1. `process.platform=linux`；
2. `flock/sharp/node-pty/node:sqlite` 四个 `require` 全成功；
3. `verify-c.json` 的 `fail=0`（尤其 `workspace 外写入未拦截` / `mkdirat 逃逸`）；
4. `engine.log` 无 `did not activate` / `SANDBOX_UNAVAILABLE` / `SessionAlreadyOwned`。

---

## 6. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 文本锚点随引擎升级静默失效 | 高 | 高 | 改为 fail-loud + 横幅（P3.2）；能进 profile 的不写锚点 |
| R2 | proot 对某些 syscall 不支持 | 中 | 中 | 记录已知清单；关键路径加回退 |
| R3 | glibc 符号覆盖面不足 | 中 | 中 | `verify-c.sh` 覆盖 python/tee/sed；新增入口先查 `*at`/`__*_2` |
| R4 | SELinux 在 proot 内仍生效 | 确定 | 中 | 预载 `liblinkcompat.so`；`ENOSYS` 也转译 |
| R5 | 手机内存/温控导致长任务失败 | 高 | 中 | `jobs`+`spill`；重活卸载远端 |
| R6 | 插件把引擎带崩 | 中 | 高 | 四级救援 + 隔离层（已有） |
| R7 | 资产体积（rootfs 200MB+node 90MB） | 确定 | 中 | 按需安装；首次下载走 Wi-Fi |
| R8 | 远端模式暴露面 | 中 | 高 | 绑具体 IP + `--trusted-host` + token/TLS；不开 wildcard |
| R9 | 桥的重复执行 | 中 | 中 | `id` + 消费即删 + 30s 陈旧丢弃 |
| R10 | 升级 rc.3 后行为漂移 | 中 | 中 | 升级前跑锚点核对 + `verify-c` 回归 |

---

## 7. 回退手册

| 场景 | 动作 |
|---|---|
| proot 起不来 | 设置页切回 bionic；或 `EngineBootGate` 自动回落（已实现） |
| 砂层误拦 | 临时 `sandbox-policy.mode: danger-full-access`（官方逃生舱），再修 runner |
| link 报错 | 检查 `LD_PRELOAD` 是否含 `liblinkcompat.so`；proot 下确认 ENOSYS 补丁 |
| 引擎升级后异常 | 回退 `assetStamp` 到上一版 + 恢复 `engine.bin` |
| 插件带崩 | 救援模式（L2）/ 安全模式（L3）/ 日志页摘插件（vc23 能力） |
| 数据迁移 | 导出/导入（只含 sessions/profiles/storages/skills/workspace/credentials） |

---

## 8. 术语

| 词 | 含义 |
|---|---|
| **宿主（Host）** | 让引擎跑起来的环境：bionic / proot-glibc / remote |
| **砂层** | `boo-sandbox-run` + `libboosandbox.so`，用户态写拦截 |
| **runnerCommand** | `dsh-sandbox-local` 的操作员口子：非空即跳过平台探测 |
| **桥（Bridge）** | 把一侧能力暴露给另一侧：文件信箱 / provider / MCP / 卸载 |
| **锚点补丁** | 用引擎内部文本做替换的补丁；升级即可能失效 |
| **去 stale** | 丢弃过期命令，避免开机自执行 |

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-26 | 建立本计划；宿主抽象、glibc 适配、装配/验收、MCP 桥、切换接线全部落盘；仓库全量替换为本地内容（应用名 DSH） |
| — | 后续每次合并请在此加一行（日期 + 一句话） |
