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

## 七、已落地：设置页「开发环境」分节（2026-10-27 真机）

不再只是脚本 —— 现在有界面了：位置是「设置 → 开发环境」（order 27，排在「运行日志」28 之前）。

### 组件与数据通路

```text
settings.section（client.js）
   ├─ GET  /api/dsh-android/devenv            -> { ok, status, job, logTail }
   └─ POST /api/dsh-android/devenv {action,id} -> 202 { job }
             ↓ （插件宿主半 lib/index.js，app uid）
        spawn files/termux/usr/bin/node files/dsh-env.mjs <action> <id>
             ↓
        files/devenv-job.json   running/pid/exit（UI 每 2s 轮询）
        files/logs/devenv.log   任务输出尾部（UI 显示进度）
        files/env-state.json    每项装了哪些包（卸载差分的唯一依据）
```

- `dsh-env.mjs` 由 `EngineManager.ensureDevEnvScript()` 从 `assets/dsh-env.mjs` 落盘（比字节数，变了才写）；
- 安装/卸载都是**后台任务**：POST 立刻回 202，UI 靠轮询看 `job.running`，不会因为 apt 跑几分钟而 HTTP 超时；
- 卸载二次确认；「回到最小环境」= `reset`（卸掉全部可选项，保留 Node 与必需项）。

### 真机验证（2026-10-27）

```text
GET  /api/dsh-android/devenv -> 200
  {ok:true, status:{builtin:{node:"v26.12.1"}, totalMb:2725, freeMb:154817, items:[...]}}

POST {action:"install", id:"go"} -> 202 {job:{running:true,pid:18022,...}}
  轮询 -> AFTER-INSTALL installed=true version=go1.27.3 sizeMb=219 tracked=true
POST {action:"remove",  id:"go"} -> 202
  轮询 -> AFTER-REMOVE  installed=false tracked=false（体积回落到基线 ±6 MB）
```

界面上六行都渲染出来（Node.js 带「必需」标签且无卸载按钮）：

```text
Node.js        v26.12.1                 必需
Python 环境    3.14.8 · 未纳管            卸载
SSH 工具       10.6p1 · 未纳管            卸载
Java 环境      17.0.21 · 未纳管           卸载
Rust(Cargo)    rustc 1.99.1 · 未纳管       卸载
Go 环境        未安装 · ~200 MB           安装
已用 2726 MB · 可用 153531 MB  [刷新] [回到最小环境]
```

「未纳管」= 这一项是**手动 apt 装的**，没有 `env-state.json` 记录，因此没有精确差分体积；
这种情况下点卸载不会误删（没有记录就没有删除集合），只会提示没有可删的包。

### 两个必须记住的坑（都踩过）

1. **分节组件第一行必须是 `const React = mpPrivReact;`**
   本文件的 `React` **不是全局变量**，只写 `React.createElement` 而漏了这行，组件一渲染就抛
   `React is not defined`；错误被 slot 吞掉，现象是「点开开发环境只有标题、内容全空」。
2. **改了 `mobile-ui-plugin/**` 必须 bump `MOBILE_UI_VERSION`**
   版本戳相同 -> `ensureMobileUi()` 直接跳过解包 -> 老设备永远拿不到新分节
   （本次先升 104、改完客户端再升 105，就是为了避免「代码推了、界面没变」）。

## 八、v2：分组 + 子项（对齐 Operit「环境配置」向导）

设置页从「六行」升级为**六张卡片**，每张卡片里是子项勾选（Node.js / Python / SSH / Java / Rust / Go）。

### 六组 × 子项与安装器

| 组 | 子项 | kind | 实现 |
|---|---|---|---|
| Node.js（必需·只读） | Node.js、PNPM | builtin | 内建运行时，只探测 |
| Python | Python | apt | `apt install python` |
| | Python 链接 | link | `ln -s python3 python` |
| | 虚拟环境、Pip | check | `python3 -c "import venv, ensurepip"` / `pip --version` |
| | uv | apt | **Termux 仓里有 `uv` 0.13.5**（不用 pip：py3.14 只能源码构建，必失败） |
| SSH | SSH 客户端、sshpass | apt | `openssh`、`sshpass` |
| | OpenSSH 服务器 | check | `sshd -V`（同属 openssh 包） |
| Java | OpenJDK 17 | apt | `openjdk-17` |
| | Gradle | apt | **`gradle` 包**（不再自己下 130 MB zip + 软链） |
| Rust | Rust & Cargo | apt | `rust` |
| | rustup 工具链 | custom | 官方脚本，**标为实验**（Termux 无二进制包） |
| Go | Go | apt | `golang` |

### 交互

- 组头：标题 + `（必需）` + 说明 + `n/m` 徽章 + 「全选」 + 折叠箭头；
- 子项：勾选框 + 名称 + 描述 + 右侧 `版本 · 体积`（未装显示 `~预估`）；
- 底部：`刷新` / `跳过` / `开始配置`；**取消勾选已装项 = 卸载**，点开始配置时先二次确认；
- 执行中：按钮置灰，展开「任务输出」实时看 apt/pip 日志；
- 后端调度：apt 串行（dpkg 锁），其余并行 —— 对应界面上的「支持并行安装」。

### 批量接口

```jsonc
POST /api/dsh-android/devenv
{"action":"install","ids":["ssh.sshpass","java.gradle"]}
→ 202 {"ok":true,"job":{"running":true,"action":"install","ids":[...],"pid":30346}}

GET 同一路径 → {"ok":true,"status":{...,"groups":[...]},"job":{...},"logTail":"…"}
```

脚本侧同样支持批量：`dsh-env.mjs install ssh.sshpass java.gradle` / `group:python` / `all`。

### 真机验证（2026-10-27）

```text
status → 6 组：nodejs 2/2、python 4/5、ssh 2/3、java 1/2、rust 1/2、go 0/1
install python.uv   → ✅ uv 0.13.5 (aarch64-linux-android)  33 MB
remove  python.uv   → ✅ 卸载后 verify ok:false
install ssh.sshpass → ✅ sshpass 1.10
remove  ssh.sshpass → ✅（含“幽灵文件”清理）verify ok:false
HTTP 批量 install [ssh.sshpass, java.gradle] → 202，job.ids 正确回显
```

### 五个新坑（这一轮踩的）

1. **`assets/dsh-env.mjs` 会在每次启动覆盖 `files/dsh-env.mjs`**
   `ensureDevEnvScript()` 比字节数，不等就重写。热替换脚本后**不要再重启 App**（或先换掉 assets）。
2. **任务文件必须先写再 spawn**
   否则 GET 会读到上一轮的旧 job（`running:false`），客户端以为任务已结束 —— 真机上“删 sshpass 秒回旧状态”就是这个。
3. **幽灵文件**：apt 在“解包完、未写 dpkg 库”时被打断（例如上层命令被 SIGPIPE 杀掉），
   dpkg 说 `not installed` 而二进制还在。现在卸载末尾会补一刀：探测仍通过就删掉该可执行文件。
4. **pip 在 Python 3.14 上装不动 uv**
   Termux 的 py3.14 没有 uv 轮子，pip 会去**源码构建**，再因 truststore/权限失败。→ 改用 apt 的 `uv`。
5. **组件里 `React` 不是全局**
   分节组件第一行必须 `const React = mpPrivReact;`，否则渲染抛 `React is not defined`，面板只剩标题。

### v2.1 补丁（同日，真机连载）

| 问题 | 现象 | 修法 |
|---|---|---|
| uv 走 pip | py3.14 无轮子 → 源码构建 → truststore 权限错 | 改 apt `uv`（0.13.5） |
| Gradle 自下载 zip | 130 MB + 软链，慢且易断 | 改 apt `gradle`（9.8.2） |
| Termux 前缀写死 | `$PREFIX/bin/*` 脚本里是 `/data/data/com.termux/files`，导致“装上了却找不到” | `fixPrefixShims()`：安装后把 bin 下小文本里的前缀改成 App 路径 |
| gradle wrapper 缺 jar | `Unable to access jarfile …lib/gradle-gradle-cli-main-9.8.2.jar` | `fixGradleLauncher()`：软链 `bin/gradle → opt/gradle/bin/gradle`（实测 `gradle -v` 正常） |
| rustup | `rustls-platform-verifier … panicked: Expect … to be initialized` | 标 `unsupported`，界面禁用勾选并写明原因 |
| `window.confirm` | WebView 原生对话框阻塞 JS，自动化点不到「确定」 | 改页内确认条（第二次点「开始配置」才执行） |
| picked 初始化 | v1→v2 换 id 后 picked 全 undefined → 误判“全部卸载” | 只有当前所有 id 都在 prev 里才算初始化完成 |

真机闭环（UI 驱动，不是 CLI）：

```text
tap 勾选框(gradle) → tap 「开始配置」
→ devenv-job.json: {"running":true,"action":"install","ids":["java.gradle"],"pid":23498}
→ devenv.log: apt-get install -y gradle …
→ 修前缀 → 软链启动器 → ✅ Gradle 完成
```

另外实测确认：**UI 点击→POST→job→日志**这条链是通的（先是误点了 rustup，日志里立刻出现
`rustup 安装失败`，说明失败也会如实回传，不吞错）。

### v2.2 收尾（UI-only 验收 + 两处清理）

| 修复 | 说明 |
|---|---|
| gradle 残留目录 | apt purge 后 `$PREFIX/opt/gradle` 仍在 → 卸载末尾按 `cleanupDirs` 删掉（真机清完后 `exists=false`） |
| unsupported 不计已装 | rustup 失败会留下 `~/.cargo/bin/rustup`，probe 通过 → 界面误报 2/2；`status` 对 unsupported 一律 `installed:false`，现为 1/2 |
| unsupported 勾选框 | 显示为未勾选且 disabled（之前会显示勾上但点不动） |

**UI-only 验收记录（2026-10-27，装 1.0.0-107 后）**：

```text
打开 设置 → 开发环境：六张卡片全部渲染
  Node.js 环境 2/2（必需）   Python 4/5   SSH 2/3
  Java 1/2   Rust 1/2（rustup 置灰，desc=Termux 不支持）   Go 1/1

取消勾选 Gradle → 点「开始配置」
  → 页内确认条出现（不再弹原生对话框）
  → 再点「开始配置」
  → devenv-job.json {action:remove, ids:[java.gradle], pid:8159}
  → logs: Removing gradle (1:9.8.2) …
  → 15s 后 job exit=0，bin/gradle 不存在，Java 组回到 1/2
```

也就是说：**勾选状态 → 计划 → 确认 → 后台任务 → 日志 → 状态回读** 这条闭环完全由界面驱动，不依赖 CLI。

### v2.3 UI 批量与版本解析（2026-10-27，装 1.0.0-108 后）

**A. 单项（uv）**：勾选 uv → 开始配置

```text
devenv-job.json {action:install, ids:["python.uv"], pid:24997}
logs: Unpacking uv (0.13.5) …  → exit=0（22 s）
status: Python 组 5/5，uv 0.13.5 (aarch64-linux-android) · 33 MB
```

**B. 批量（两项一次提交）**：同时勾选 sshpass + Gradle → 开始配置

```text
devenv-job.json {action:install, ids:["ssh.sshpass","java.gradle"], id:"2 items", pid:26215}
logs: Setting up sshpass (1.10-1) … ✅ sshpass 完成
      → 安装 Gradle …（apt 串行执行）
→ 27 s 后 exit=0；SSH 3/3、Java 2/2
```

**C. 版本解析修复**：Gradle 的 `gradle -v` 第一行是分隔线 `-----…`，之前只取首行 → 界面显示一串横线。
现在 `normalizeVersion()` 收**整段输出**并用 `/Gradle\s+([\d.]+)/` 抓版本，显示 `9.8.2 · 165 MB`。

最终六组真机状态（截图确认）：

```text
Node.js 2/2 · Python 5/5 · SSH 3/3 · Java 2/2 · Rust 1/2（rustup 置灰）· Go 1/1
```

> 「全选」按钮本身未单独点测（它只对非必需项生效，当前环境除 rustup/sshpass 外已全装）；
> 组级行为等价于“批量勾选”路径，已由 B 覆盖。

> 验收判据见 [verification.md 的 ⑤ 开发环境（六组）](verification.md)。
