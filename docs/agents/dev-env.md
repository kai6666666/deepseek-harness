# 开发环境（Operit「环境配置」六项）在 DSH 里的落点

> 结论先说：**界面没移植，能力全都在。**
> 六项里 Node 是内置运行时（不靠 apt），其余五项由 bootstrap 自带的 apt 一条命令装好，
> 2026-10-27 已在真机（Xiaomi 25104RADAC / Android 16）逐项编译运行验证。

## 一、审计：Operit 有的，DSH 有什么

| Operit「环境配置」项 | DSH 现状 | 落地方式 |
|---|---|---|
| Node.js 环境 | ✅ **内建**（`node-runtime.bin`，v26.12.1） | `assets/node-runtime.bin` → `files/termux/usr/bin/node`，与 apt 无关 |
| Python 环境 | ✅ 已装（Python 3.14.8 + pip 26.2.2） | `apt install python` |
| SSH 工具 | ✅ 已装（OpenSSH 10.6p1 / OpenSSL 3.6.5） | `apt install openssh` |
| Java 环境 | ✅ 已装（OpenJDK 17.0.21） | `apt install openjdk-17` |
| Rust(Cargo) 环境 | ✅ 已装（rustc / cargo 1.99.1） | `apt install rust` |
| Go 环境 | ✅ 已装（go1.27.3 android/arm64） | `apt install golang` |

⚠️ **Node 不要用 apt 装**：`nodejs` 包会把 `$PREFIX/bin/node` 覆盖成 Termux 版，
而引擎是按自带 runtime 的布局（含 `libcares` / `libicu` / 四个原生模块）准备的。

## 二、为什么 DSH 不照搬 Operit 那套界面

| 维度 | Operit | DSH |
|---|---|---|
| 环境底座 | Termux bootstrap + 向导分步（Python → uv → Node → pnpm） | **同一个 Termux bootstrap**（240 MB / 400 个二进制，含 apt/dpkg） |
| 安装入口 | 设置页「配置终端环境」+ 向导卡片 | 无 UI，`tools/dsh-env.sh` |
| 镜像 | 向导里配清华源 | `sources.list` = USTC Termux 仓；`pip.conf` = 国内 PyPI（`MirrorProbe` 生成，见该文件 KDoc） |

也就是说：**缺的是那一页 UI 与向导，不是能力。** 这也是为什么这次没有把 Operit 的
`OperitTerminalWizardCard` 一整套搬过来 —— 它绑死在 Operit 的 `TermuxInstaller`
与 Compose 导航上，搬过来的成本远高于在 DSH 里写一个「读 status / 点安装」的分节。

## 三、真机证据

```text
── DSH 环境体检 ──────────────────────────────
PREFIX = /data/user/0/com.dsh.android/files/termux/usr
磁盘   = 2.3G

node     ✅ v26.12.1
python   ✅ Python 3.14.8
pip      ✅ 26.2.2
ssh      ✅ OpenSSH_10.6p1, OpenSSL 3.6.5 29 Sep 2026
java     ✅ openjdk version "17.0.21" 2026-10-20
rustc    ✅ rustc 1.99.1 (58cf8f9c3 2026-10-13)
cargo    ✅ cargo 1.99.1 (5f94df478 2026-08-27)
go       ✅ go version go1.27.3 android/arm64

apt 源：deb https://mirrors.ustc.edu.cn/termux/apt/termux-main/ stable main
```

编译运行冒烟（`tools/env-smoke.sh`，全部在设备上跑）：

```text
=== python ===  py-ok 2
=== rust ===    rust-ok
=== go ===      go-ok
=== java ===    java-ok 17.0.21
=== node ===    node-ok v26.12.1
=== ssh ===     OpenSSH_10.6p1, OpenSSL 3.6.5 29 Sep 2026
```

## 四、怎么用

```bash
# 体检（只读，随时可跑）
run-as com.dsh.android sh -c 'files/termux/usr/bin/bash files/dsh-env.sh status'

# 装单项 / 多项 / 全装
run-as com.dsh.android sh -c 'files/termux/usr/bin/bash files/dsh-env.sh install python ssh'
run-as com.dsh.android sh -c 'files/termux/usr/bin/bash files/dsh-env.sh install java rust go'
run-as com.dsh.android sh -c 'files/termux/usr/bin/bash files/dsh-env.sh install all'

# 六项编译运行冒烟
run-as com.dsh.android sh -c 'files/termux/usr/bin/bash files/env-smoke.sh'
```

两个脚本都在 `tools/`：`dsh-env.sh`（体检/安装）、`env-smoke.sh`（编译冒烟）。
推到设备上：`cp tools/*.sh /sdcard/Download/…` → `/data/local/tmp/` → `run-as … cp` 进 `files/`。

## 五、体积与耗时（真机实测，USTC 源 244 KB/s）

| 项 | 解压后占用 | 备注 |
|---|---|---|
| python (+llvm/clang 依赖) | 约 690 MB | Termux 的 `python` 依赖 `llvm`，这是最大的一块 |
| openssh | 约 12 MB | |
| openjdk-17 | 约 400 MB | |
| rust (rustc + cargo) | 约 1.1 GB | 装完 `files/termux` 从 931 MB 涨到 2.3 GB |
| golang | 约 200 MB | |

## 六、如果要把它做进设置页（未做的部分）

最小实现三段，不需要碰引擎：

1. **状态**：`ProcessBuilder` 跑 `dsh-env.sh status`，把六行解析成 `Map<String,String>`；
2. **动作**：点某一项 → 后台跑 `dsh-env.sh install <item>`，把 stdout 逐行喂进现有日志视图；
3. **呈现**：设置页加一个「开发环境」分节（与「特权权限」并列），每行显示 ✅/❌ + 版本 + 安装按钮。

⚠️ 注意两件事：
- 安装是**分钟级**任务，必须前台服务或至少 `Thread + 进度回执`，否则用户切走会被杀；
- `apt install` 会写 `$PREFIX`，与引擎解包并发时要加同一把锁（`TermuxBootstrap` 已有
  `.bootstrap_done` 与 flock 机制，复用即可）。
