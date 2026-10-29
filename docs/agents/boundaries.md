# 已知边界

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## 已知边界

- **终端/PTY 执行**：已接入（见 ⑩）。侧栏终端可用，但**沙箱不隔离 PID 命名空间**
  （见上），且 app 域下 `/proc` 只能看见自己 uid 的进程。
- **中断处理**：用户自行解决，别自作主张加。
- **`libboosandbox.so` 已构建并接入**（见「④ Android 没有内核级沙箱后端」）。
  它同时是 shell 写入沙箱的强制层。
- **沙箱不隔离 PID 命名空间**：`--unshare-pid` 需 CAP_SYS_ADMIN，普通应用拿不到。
  文件写边界是完整的。
- **`engine-overlay/disable-native.yml` 已废弃**，可删。
- **`x/` 目录是空的**，可删。
- **`engine.bin` 在 APK 内每轮构建都要重新压缩**（52 MB）。若嫌构建慢，可在首次启动时
  改用 `adb push`，能把构建压到 10 秒内。
- **APK 约 117 MB**：`engine.bin` 52 MB + `node-runtime.bin` 30 MB + bootstrap 23 MB
  + pnpm zip 5.9 MB + ripgrep 2 MB。若嫌大，pnpm 可改为首次启动联网下载，
  代价是离线不可用（现在它是离线的）。
- **VMOS+ guest 的真模型线不纳入闭环判据**：guest 侧要真模型驱动 App UI，依赖
  「VMOS 保持前台 + guest 内 DSH 已登录模型账号」两个外部条件；VMOS 一退后台即被挂起、
  adbd 直接 `offline`（实测卡满 30 分钟后强制中断）。因此：
  guest 只要求 **mock 矩阵**（`--tools --root --guest` → 8 PASS / 0 FAIL / 2 SKIP，含 root 真实 `uid=0`），
  真模型三条线（`--llmtools` / `--llmsplit` / `--llm`）只在宿主跑。
  详见 [verification.md](verification.md) ⑯.3 与验收手册 B 节。
- **guest 里 `run-as` 不可用**（`setegid(AID_PACKAGE_INFO) failed: Operation not permitted`），
  guest 内一律 `su -c` 执行；宿主相反 —— `run-as` 可用，但**不要**把 `verify-all.sh` 包进 `run-as`
  （脚本内部自己降权，外层再包会 `Permission denied`）。
