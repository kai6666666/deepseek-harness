# toolchain-overlay —— 要用 apt 装重工具链，怎么办

> 一句话：**别把 apt 塞进运行档。** Alpine 档继续当唯一运行档（engine 只有一份），
> 需要 apt 的东西走一个「可抛弃的 Ubuntu 层」：装得上、用完能删、产物过 ABI 守卫才准进引擎。

---

## 0. 先认清三个层，别把它们混成一个「档」

| 层 | 是什么 | 常驻？ | 体积 | 谁在用 |
|---|---|---|---|---|
| **apk 层** | Alpine 官方 musl 包 | 是（= 运行档本身） | 89 MB | 引擎 + 大部分工具链 |
| **deb 层** | 从 .deb 挖出的单文件二进制 + `gcompat` | 可删 | 5–15 MB/个 | 单文件 CLI（gh 之类） |
| **overlay 层** | Ubuntu base rootfs + 真 `apt` | **可删、按需挂** | 30 MB 起，装 JDK 约 300 MB | 真的需要依赖树的场景 |

**关键区分**：`backend-select.mjs` 里那叫「档（backend）」，指的是**跑引擎的运行时**。
这里三层都不是运行档——**engine 永远只有 Alpine 一份**，overlay 里绝不启动 DSH。
这就是它和「双档」的根本区别：双档要两套 engine，overlay 不要。

---

## 1. 命令 → 层 的路由表

`toolchain.json` 是唯一真源，`verify-toolchain.sh --which <cmd>` 直接查它。

```text
apk 层（首选，musl，最省）：
  go  rustc  cargo  java  javac  mvn  ffmpeg  gcc  g++  make  cmake
  git  adb  pandoc  python3  pip  uv  node-gyp  build-base

deb 层（单文件 CLI，官方只发 .deb）：
  gh  （以及各种 vendor 单文件工具）

overlay 层（真需要 glibc 依赖树）：
  gradle  aapt2  d8  sdkmanager  dotnet  playwright  chromium
  onnxruntime  rustup
```

```bash
bash verify-toolchain.sh --which java
#   java: layer=apk  (Alpine 原生 musl 包)
#     装: apk add --no-cache openjdk17-jdk
```

---

## 2. 快速开始

```bash
cd DSHAPP-main/tools/toolchain-overlay

# ① 只想要 apt（最小层，~90 MB）
bash install-overlay.sh

# ② 要 JDK + gradle（一次到位）
bash install-overlay.sh --packages default-jdk,gradle

# ③ 让 `apt` 这个命令名在 Alpine 里也能用
bash apt-shim.sh --install
export PATH="$HOME/.dsh/toolchain/bin:$PATH"
apt-get install -y --no-install-recommends openjdk-17-jdk

# ④ 单文件 CLI 不装 Ubuntu，直接从 deb 里挖
bash deb-extract.sh --pkg gh --dist noble --component main --bin gh

# ⑤ 体检
bash verify-toolchain.sh
```

---

## 3. 三条铁律（不遵守就会崩）

### 铁律 1：overlay 里永远不跑引擎

```text
✗ proot -r ubuntu ... node engine/bin.js        # 会产生第二套 engine，ABI 互斥
✓ proot -r ubuntu ... apt-get install gradle    # overlay 只当「编译/装包机器」
✓ proot -r alpine ... node engine/bin.js        # 引擎永远在 Alpine
```

### 铁律 2：产物进 Alpine 之前必须过 ABI 守卫

```bash
bash verify-toolchain.sh --abi ~/.dsh/engine/node_modules
#   ✗ glibc  xxx.node  ← 不许进 Alpine 引擎
#   ✓ musl   yyy.node
```

判定不依赖 `readelf`，直接看动态加载器字符串：

| 特征 | 归属 |
|---|---|
| `ld-linux-aarch64.so.1` / `GLIBC_2.x` | glibc（只配 Ubuntu） |
| `ld-musl-aarch64.so.1` / `musl libc` | musl（配 Alpine） |
| 两者都没有 | static（谁都能跑） |
| `liblog.so` / `/system/lib64` | bionic（只配 Termux） |

### 铁律 3：overlay 是缓存，不是资产

可以随时 `rm -rf ~/.dsh/toolchain/ubuntu`。
所以：**任何「只在 overlay 里存在」的东西都不许被引擎依赖**。
`install-overlay.sh` 已把 `.deb` 缓存放 `/dsh-home/toolchain/cache`（overlay 外），
删 rootfs 不会连带删掉下载过的包。

---

## 4. proot 里跑 apt，四个必踩的坑（脚本已全部处理）

| 坑 | 现象 | 处理 |
|---|---|---|
| `_apt` 沙箱用户切换失败 | `E: setgroups 失败` / `Couldn't create temp files` | `APT::Sandbox::User "root"` 写进 `99-proot` |
| postinst 想启服务 | 安装卡死、`invoke-rc.d` 报错 | `policy-rc.d` 返回 101 |
| man/doc/locale 占地 | rootfs 白胖 20–30% | `dpkg.cfg.d/99-proot` 的 `path-exclude` |
| arm64 源不对 | `404` / 只找到 x86 包 | 用 `ubuntu-ports` + deb822 格式的 `ubuntu.sources` |

另外两个脚本已经处理掉的：
- `--link2symlink`（dpkg 解包用硬链接，proot 需要转译）
- `Dir::Cache::archives` 外置（避免 rootfs 被缓存撑爆）

---

## 5. 体积账（实测/估算）

```text
Alpine 运行档（永远在）        89 MB
overlay 最小层                 ~90 MB（含 base 30 MB 下载）
overlay + JDK + gradle        ~300 MB
deb 层 gh                       ~12 MB
```

**对比**：把 Ubuntu 当运行档 = 300 MB 常驻 + 还得再放一份 engine。
**这里**：300 MB 只在「真的要 gradle」时才存在，删了不影响任何东西。

---

## 6. 失败时的三条诊断线

| 症状 | 诊断 | 修 |
|---|---|---|
| `apt-get` 报 `E: Unable to locate package` | 源/组件不对 | `install-overlay.sh --mirror http://ports.ubuntu.com/ubuntu-ports`；加 `--component universe` |
| overlay 里 `node: not found` | 正常：overlay **不该**有 node | 别在 overlay 跑引擎，用 Alpine 档 |
| `deb-extract` 的 wrapper 报 `not found` 但文件在 | 缺 glibc 符号 | `apk add --no-cache gcompat libstdc++`；再不行改走 overlay |

---

## 7. 文件清单

| 文件 | 行数级 | 作用 |
|---|---|---|
| `toolchain.json` | 66 | 路由表 + ABI 守卫规则 + 体积预算（唯一真源） |
| `install-overlay.sh` | 219 | 探测 ubuntu-base → 解包 → 注入 proot apt 配置 → update → 可选预装 |
| `tc-run.sh` | 138 | overlay 执行器（与 `proot-launch.sh` 同一套 proot 参数） |
| `apt-shim.sh` | 83 | 把 `apt/apt-get/dpkg` 做成同名 shim，透明落进 overlay |
| `deb-extract.sh` | 186 | 纯 python 解 `ar`，挖出二进制 + 生成宿主 wrapper |
| `verify-toolchain.sh` | 170 | 三层体检 + ABI 守卫 + 路由查询 |
| `README.md` | — | 本文件 |

已同步改动：
- `tools/alpine-runtime/proot-launch.sh`：新增 `-b $DSH_HOME/toolchain/deb:/opt/deb`（存在才绑）
- `tools/toolchain-overlay/tc-run.sh`：同上，且不绑不存在的路径（proot 会直接失败）

---

## 8. 验收清单

```bash
# 全部通过才算接好
bash install-overlay.sh --dry-run          # 探测 URL + 打印将注入的配置
bash tc-run.sh --dry-run -- apt-get update # 打印完整 proot 命令行
bash verify-toolchain.sh --which gradle    # overlay
bash verify-toolchain.sh --which java      # apk
bash deb-extract.sh --list                 # deb 层现状
bash verify-toolchain.sh --overlay         # 真跑 ldd + apt-get --version
```