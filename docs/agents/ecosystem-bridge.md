# 生态剩下那 20%：四种桥，和桥不到的地方

> 前提：C 方案（proot/glibc）已经把 **ABI 层**补齐（官方原生依赖 6/7、`linux-arm64-gnu`
> 第三方包基本可用）。剩下的 20% 与 libc 无关，只能靠**换宿主**或**加桥**。

## 1. 先把 20% 拆开（别当成一坨）

| 缺口类别 | 典型插件/能力 | 换 glibc 有用吗 | 本质 |
|---|---|---|---|
| **A. 内核特性** | `bwrap`/`landlock`/`io_uring`/PID ns/seccomp user-notify | ❌ | 内核没编、没权限 |
| **B. Android API** | 无障碍、Shizuku、root、通知、相机、传感器、分享 | ❌ | 插件跑在 Node 里，够不到 Java/系统服务 |
| **C. 浏览器引擎** | `playwright`/`puppeteer`/`stagehand` | ❌ | 手机没有 Chrome/Chromium 运行时 |
| **D. GPU / CUDA** | `onnxruntime-gpu`、`torch` CUDA 版 | ❌ | 没有 NVIDIA 设备 |
| **E. 平台专属二进制** | 只发 `win32-*` / `darwin-*` 的包 | ❌ | 没有对应产物 |
| **F. 桌面壳语义** | Electron 多窗口/托盘/全局热键 | ❌ | 没有桌面 |
| **G. 资源型** | 大内存模型、长时编译、海量 grep | 部分（glibc 有真二进制） | 手机物理上限 |

## 2. 四层桥（从便宜到贵）

```text
L1 文件信箱桥（已有）
   $DSH_HOME/*-cmd.json / *-result.json  ←→ Kotlin
   优点：零协议、零端口、可审计；缺点：只有本机、逐条轮询

L2 Provider 桥（官方 seam）
   ctx.computerUse.register(...) / ctx.browserUse.register(...)
   优点：模型看到的是**原生工具语义**，预设/权限/审批全部复用；缺点：要写插件

L3 协议桥（本次交付：MCP）
   mcp-android：Android 能力 → 标准 MCP server
   优点：本机/远端/任何 agent 都能用，dsh 原生注册；缺点：多一跳

L4 卸载桥（远端执行）
   jobs / ssh / workflow 把「做不了的步骤」发给 PC 或 VM
   优点：保真度 100%；缺点：依赖另一台机器
```

**结论先说**：**A/C/D/F 四类桥不到，只能换宿主（L4 或 AVF/远端）；B/E/G 三类可以桥，而且 L3（MCP）是性价比最高的那条。**

## 3. 逐类方案矩阵

| 缺口 | 方案 | 保真度 | 成本 | 推荐 |
|---|---|---|---|---|
| **A 内核沙箱** | ① AVF Linux VM（guest 内核，userns+Landlock 都在） | 100% | 换机 + VM 常驻 1–2 GB | ★★★★★（未来正解） |
| | ② 远端引擎（PC/NAS/云） | 100% | 一台常开机器 | ★★★★★（现在就能用） |
| | ③ gVisor / `runsc`（ptrace 平台，arm64 有支持） | ~90% | 高（要跑 OCI 运行时，权限门槛高） | ★★ |
| | ④ 用户态拦截（现状 `boo-sandbox-run`） | 写边界 80%（无 PID ns、无 symlink 解析） | 已完成 | ★★★（够用） |
| | ⑤ root + chroot | ❌ 同内核，仍无 userns/Landlock | 需 root | ☆（伪解） |
| **B Android API** | ① **L3 MCP 桥**（本次交付 `bridge/mcp-android`） | 90%（语义等价，非同一 API） | 1–2 人日 + Kotlin 轮询 | ★★★★★ |
| | ② L2 provider 桥（`computer-use`/`browser-use` 注册） | 95%（模型看到原生工具） | 3–5 人日/provider | ★★★★ |
| | ③ L1 文件信箱（现状：`ui`/`bubble`/`shell` 工具） | 85% | 已完成 | ★★★★（继续用） |
| **C 浏览器引擎** | ① 原生 WebView 包成 `browser-use` provider（DSHAPP 已有 `browser` 工具） | 85%（可登录、可截图、可接管） | 5 人日 | ★★★★ |
| | ② 远端浏览器（Playwright server / browserless） | 100% | 一台机器 + 网络 | ★★★★ |
| | ③ Android Chrome + CDP（`adb forward localabstract:chrome_devtools_remote`） | 70% | 2 人日 + 需 adb/Shizuku | ★★（脆） |
| **D GPU/CUDA** | ① 远端推理 | 100% | 云成本 | ★★★★ |
| | ② 换 NNAPI/QNN/ONNX CPU（不是 CUDA 兼容，只是能跑） | 40% | 中 | ★★★ |
| **E 平台专属包** | ① 找同功能 `linux-arm64` 包替换 | 80% | 低 | ★★★★★ |
| | ② 自己编 N-API 包装（上游开源时） | 100% | 2–5 人日/包 | ★★★ |
| | ③ 把该步骤卸载到远端（L4） | 100% | 低 | ★★★★ |
| **F 桌面壳** | 用悬浮球/通知/分屏替代；不追等价 | 50% | 低 | ★★★（够用） |
| **G 资源** | `jobs` + `spill` + 远端；手机只做交互 | 80% | 低 | ★★★★ |

## 4. 决策树（贴墙上那种）

```text
插件跑不起来
├─ 报 module not found / NODE_MODULE_VERSION / glibc?
│   → 是 ⇒ C 方案（proot glibc）+ npm rebuild（ABI 问题）
├─ 报 bwrap/landlock/no sandbox backend?
│   → 是 ⇒ 不是插件问题，是宿主：danger-full-access 兜底，或换 AVF/远端
├─ 报 ENOENT chrome / executablePath?
│   → 是 ⇒ C 类：原生 WebView provider 或远端浏览器
├─ 报 permission denied 访问 Android 系统能力?
│   → 是 ⇒ B 类：加 MCP 桥（L3）或 provider（L2）
├─ 报 EACCES link / EINVAL rename?
│   → 是 ⇒ 预载 liblinkcompat.so（已在 C 方案里）
└─ 只是慢 / OOM?
    → G 类：jobs+spill、或把该步骤卸载到远端
```

## 5. 桥的三条纪律（写桥之前先记住）

1. **幂等**：每条命令带 `id`，宿主消费后**删除**命令文件。
   DSHAPP 的 `ui` 桥就因为没删结果文件出现过「重复点击」。
2. **失败要显式**：桥返回 `{ok:false,error}`，不要让调用方等超时。
   超时文案要指路（“检查 Kotlin 是否在轮询 xxx.json”）。
3. **不开裸端口**：L3 若走网络（远端 dsh 用本机能力），必须 token/TLS/受限监听；
   文件信箱天然满足这条，所以优先 L1/L3 的文件形态。

## 6. 不要做的三件事

| 反模式 | 为什么 |
|---|---|
| 为了一个 win32-only 包去 fork 上游 | 维护成本 > 收益；优先找替代或远端卸载 |
| 用 seccomp 自写“路径沙箱” | seccomp 只有 syscall 号与参数寄存器，**拿不到路径**；写出来的是假边界 |
| 把 `danger-full-access` 当默认 | 它是逃生舱，不是方案；默认应 `workspace-write` + runner |

## 7. 本仓库现在具备的桥

| 桥 | 位置 | 状态 |
|---|---|---|
| L1 文件信箱 | `ui-cmd.json` / `bubble` / `browser` 等 | ✅ 已在用 |
| L2 provider | `docs/agents/proot-glibc-host.md` 的 Q1/Q2 方案 | 🟡 骨架已给，未接线 |
| L3 MCP | `bridge/mcp-android/` | ✅ 本次交付（6 个工具，stdio） |
| L4 卸载 | `jobs` + `ssh` + `dsh sdk/acp` profile | ✅ 引擎自带 |