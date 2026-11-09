# 计划 v2：单运行时（PRoot/glibc）全量切换 + dsh-Go 资产吸收

> 本版取代 v1《双路线演进计划》的「混合双模」结论。**决策：不保留 bionic 宿主，不做运行期双模切换。**
> 基线：`0.4.3` / vc=49 / 引擎 `@deepseek-ai/dsh@0.2.2-rc.1` / 真机 0.4.3（Xiaomi 25104RADAC / Android 16 / arm64-v8a）
> 仓库状态：分支已清空，只剩 `main`（`3838a7d9`）；Release `v0.4.3` 已发布
> 依据：`dsh-Go-main` 源码与文档（2026-11-08 快照）、本工程 `docs/agents/proot-glibc-host.md`
> 落盘：2026-11-09

---

## 〇、先给结论

1. **采用单一路线**：APK 内只保留 PRoot + Ubuntu 24.04(glibc) 运行时，删除 Termux(bionic) 运行时与 `node-runtime.bin`。没有 `HostMode` 开关，没有「重生态模式」按钮，没有两套启动代码。
2. **代价明码标价**：引擎启动段 +80%（dsh-Go 同机实测 1,072 ms → 1,925 ms）。**体积已实测**：`rootfs` 解包 **998 MB**（Ubuntu base + node + dsh 0.2.2-rc.1），压缩 **124 MB**；现网 `files/engine` 586 MB + `files/termux` 477 MB = 1.06 GB → 新方案约 **1.0 GB，净省约 65 MB**；APK 删 `node-runtime.bin` 30.6 MB、加 rootfs 124 MB，**净增约 93 MB**（182 → 约 275 MB，可用 P6 的资产分离消掉）。用 **boot-cache（-12~14%）+ 点开即拉起 + 常驻预热** 抵消启动开销。
3. **回滚只到版本级**：出问题 = 装回上一个 APK（同签名、`versionCode` 递增），不在 App 内做运行时切换。这样代码里永远只有一条路径，验收只有一套判据。
4. **补丁体制换血**：121 个 diff + 双哈希 pin 的做法照搬，但先做减法——本工程 10 个补丁里预计 **4 个是纯 bionic 适配，切 glibc 后直接删除**，剩 6 个进构建期 diff。

---

## 〇点五、本轮核对（2026-11-09 发布后复验）

| 项 | 核对方式 | 结果 |
|---|---|---|
| 基线门禁 | 真机跑 `verify-engine-upgrade.sh --tools`（从 `main` 取脚本） | **9 PASS / 0 FAIL / 1 SKIP**（nodejs 2/2、索引 2/4、补丁 5/5、bubble/ui/logs/statusbar/browser PASS、root SKIP） |
| 装机体积 | 设备 `du -sh files/engine files/termux` | engine **586 MB**、termux **477 MB**，合计 **1.06 GB** |
| rootfs 体积 | P0 目录 `du -sh rootfs` | **223 MB**（Ubuntu base + glibc node） |
| 补丁规模 | `EngineManager.kt` 正则统计 | `patch*` 函数 **10** 个；`GUARD` 常量 **14** 个、引用 12 处 |
| UI 耦合 | 全仓哈希类名去重 | **87** 个（`client.js` 内 34 个） |
| C 方案工具 | 仓库内容 API | `tools/verify-c.sh` 4,984 B、`tools/apply-glibc-patches.py` 6,562 B、`docs/agents/proot-glibc-host.md` 6,319 B，全部存在 |
| 工作区树 | 跑本地 `tools/verify-engine-upgrade.sh` | **8 PASS / 1 FAIL**——本地树是旧的（缺 2b2d2b47 的 required-only 判据）。**P1 起一律以 `main` 的 API 取值为准，不信任本地副本** |

结论：P0 的可行性结论不变；体积账由「+400~600 MB」修正为「**净省约 250 MB**」；锚点数量修正为 14 个常量（不随补丁删除而减少）。

---

## 一、dsh-Go 复核结果（逐文件核对，含对 v1 计划的勘误）

### 1.1 运行时构建（`runtime/build-runtime.sh`，476 行 + `runtime/lib/rtbuild.py` 71 KB）

| 事实 | 值 | 对本计划的意义 |
|---|---|---|
| DSH 版本 | `0.2.2-rc.1`（可 `DSH_VERSION` 覆盖） | 与我们同版，pins 可直接对齐 |
| Node | `24.22.1`（glibc，官方 linux-arm64 tarball） | 我们换掉 bionic 26.x |
| Ubuntu base | `24.04.5`（清华镜像，SHA256SUMS 校验） | rootfs 基线 |
| proot | `5.1.107.98`（dsh-Go 的 pin，Termux 仓库已下架）→ 现网 **`5.1.107.102`** | 版本与 loader 必须成对；pin 必须自存 |
| talloc / shmem | dsh-Go pin `2.4.3` / `0.3` → 现网 **`2.5.0`** / **`0.7`** | 同上，仓库只留最新 |
| jniLibs 四件套 | `libproot.so` `libproot-loader.so` `libtalloc.so` `libandroid-shmem.so` | 必须 `useLegacyPackaging=true` 才可执行 |
| ELF 改写 | `DT_NEEDED libtalloc.so.2 → libtalloc.so` | 否则 nativeLibraryDir 里找不到 talloc |
| 可复现 | `SOURCE_DATE_EPOCH=1767225600`，tar 固定 mtime，排序打包 | 我们也要，否则每次出包哈希都变 |
| 下载校验 | 5 个产物全部 sha256 pin（ubuntu/node/proot deb/proot 源码 zip） | 照搬 |
| runtimeVersion | `rev-dsh{ver}-node{ver}-ubuntu{ver}-{inputs_sha12}` | 比我们的 `.stamp` 信息量大，直接替换 |

**构件实测（2026-11-09，本机下载 + `dpkg-deb` / `readelf` 核对）**

| 构件 | 现网版本 | SHA-256 |
|---|---|---|
| `proot_5.1.107.102_aarch64.deb` | 5.1.107.102 | `10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030` |
| `libtalloc_2.5.0_aarch64.deb` | 2.5.0 | `556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7` |
| `libandroid-shmem_0.7_aarch64.deb` | 0.7 | `0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6` |

包内布局与 ELF 事实（决定 jniLibs 怎么摆）：

```text
proot deb:   usr/bin/proot (259,832 B)  usr/libexec/proot/loader (18,136 B)  loader32
talloc deb:  usr/lib/libtalloc.so -> libtalloc.so.2.5.0
             usr/lib/libtalloc.so.2 -> libtalloc.so.2.5.0
shmem deb:   usr/lib/libandroid-shmem.so (14,432 B)

readelf -d proot:
  RUNPATH  /data/data/com.termux/files/usr/lib     ← 必须靠 LD_LIBRARY_PATH 兜住
  NEEDED   libtalloc.so.2  libandroid-shmem.so  libc.so
```

→ 三个直接后果：①`libtalloc.so.2` **不匹配** Android 的 `lib*.so` 抽取规则，必须改名 + 改 `DT_NEEDED`；②`libandroid-shmem.so` 名字合规，直接放 jniLibs；③RUNPATH 指向 Termux 路径，启动时必须设 `LD_LIBRARY_PATH=$NATIVE_LIB_DIR`。

**Android 16 兼容性（dsh-Go 官方文档口径）**：Direct（glibc loader 直起）会被 Android 16 的 seccomp 拦死，自动回落；**PRoot 兼容启动是默认且可用路径**。这正好支撑我们「单 PRoot」的决策。

### 1.2 启动模板（`rtbuild.py:1323-1408` + `DshProcess.kt`）

真实 argv（Kotlin 侧只做占位符替换，不拼参数）：

```text
{NATIVE_LIB_DIR}/libproot.so
  --kill-on-exit --link2symlink --sysvipc -L -0
  --rootfs={ROOTFS} --cwd=/root
  -b /dev  -b /dev/urandom:/dev/random  -b /proc
  -b /proc/self/fd:/dev/fd  -b /proc/self/fd/0:/dev/stdin
  -b /proc/self/fd/1:/dev/stdout  -b /proc/self/fd/2:/dev/stderr
  -b /sys  -b {ROOTFS}/var/lib/dsh-app/empty:/sys/fs/selinux
  -b {ROOTFS}/var/lib/dsh-app/shm:/dev/shm  -b /system  -b /apex
  /usr/bin/env -i
  HOME=/root USER=root LOGNAME=root SHELL=/bin/bash
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  LANG=C.UTF-8 TERM=xterm-256color TMPDIR=/tmp DSH_HOME=/root/.dsh
  XDG_DATA_DIRS=/usr/local/share:/usr/share:/system
  pnpm_config_registry=<mirror> UV_USE_IO_URING=0 NARB_DISABLE_NATIVE_CACHE=1
  NODE_OPTIONS=--dns-result-order=ipv4first
  {GUEST_ENV}                     ← 独立元素，App 追加 KEY=VALUE（可 0 个）
  /bin/sh -c 'echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --patch <overlay> --host 127.0.0.1 --port {PORT} --no-open'
```

进程环境（`ProcessBuilder.environment()` **先 clear**）：

```text
PATH=/system/bin:/system/xbin        HOME=<filesDir>
TMPDIR=<cacheDir>/proot-tmp          PROOT_TMP_DIR=<同上>
ANDROID_ROOT=/system                 ANDROID_DATA=/data
PROOT_LOADER={NATIVE_LIB_DIR}/libproot-loader.so
PROOT_L2S_DIR={ROOTFS}/root/.l2s     LD_LIBRARY_PATH={NATIVE_LIB_DIR}
```

停止语义（这个我们现在的代码是错的）：

```text
优雅：读 {ROOTFS}/tmp/dsh-web.pid → SIGTERM 给 node → dsh 释放插件后 exit 0 → --kill-on-exit 收尾
兜底：SIGQUIT 给 proot 主进程（proot 忽略 SIGTERM/SIGINT/SIGHUP）
禁止：只 Process.destroy()（proot 不退）或 destroyForcibly()（node 变孤儿）
```

健康判据：`TCP 127.0.0.1:{PORT}` 可连 + 无 cookie `GET /` 返回 **401** + 带 `dsh-auth-*` cookie 返回 **200**；token 从 stdout 单行正则抓（`^dsh web: (http://127\.0\.0\.1:\d+/?)\?token=(\S+)$`）。

### 1.3 补丁体制（`runtime/patches/` + `pins.json`）

- 122 个文件＝121 个 `.diff` + `pins.json`；
- `pins.json` 结构：`patches[diff][dshVersion][相对路径] = {before, after}`；
- 0.2.2-rc.1 覆盖 **121 个补丁 / 89 个目标文件**；另存 0.2.1-rc.4（55）、0.2.1-rc.2（3）历史 pin；
- 构建期应用，**未 pin 的版本直接 build 失败**（脚本头注释写明 "an unvetted DSH version fails the build"）；
- 应用器是 `rtbuild.py patch-dsh --prefix … --dsh-version … --patches …`。

### 1.4 冷启动实测（`docs/design/runtime-cold-start.md`）

| 段 | proot | 不经 proot（同 rootfs 的 ld.so 直起） |
|---|---|---|
| 引擎启动（进程起 → 打印地址行） | 1,925 ms（cold 2,270） | **1,072 ms（-44%）** |
| + 启动期路径缓存（r9） | 1,662 ms（-14%） / cold 2,000（-12%） | — |
| App 级「点图标 → 对话列表」 | 3,016 ms | — |
| 提前拉起（App 启动与 Flutter 并行） | 2,638 ms | — |
| 提前拉起 + 路径缓存 | **2,462 ms（-18%）** | — |

根因数据：一次 `dsh web` 启动 **约 28,100 次路径类系统调用**（statx 17,598 / openat 4,211 / readlink 3,601 / access 2,722），proot 每次都要截获翻译，模拟器上约 30 µs/次。

> **注意**：dsh-Go 另有「Direct（glibc loader 直起）」模式，但**默认关闭**——Android 16 x86_64 的 seccomp 会杀 glibc loader。本计划**不采用**该模式（它本质是第二套启动器），只用 boot-cache。

### 1.5 测试与 CI

- 测试规模：`runtime/tests` **247** 个 `.mjs`、Kotlin 测试 **225** 个、Dart 测试 **123** 个；
- 工作流只有两个：`ci.yml`（主干/PR 全量）、`pr-gate.yml`（PR 快检）。

### 1.6 增量更新（`docs/design/delta-update.md` + `tooling/apk_delta.py`）

**不是 bsdiff**，是 zip 条目级：

```text
头  "DSHDLT01"(8) + 旧APK_SHA256(32) + 新APK_SHA256(32) + u64 新长度
0x01 COPY u64 旧偏移 u64 长度
0x02 DATA u64 长度 + 原始字节
0x00 END
```

- 生成时逐条目比对（CRC32 + 压缩后大小 + 压缩方式 + 逐字节），相同则 COPY；
- 产物必须重新应用一遍、SHA-256 与目标一致才落盘；
- 只保留 **< 整包 60%** 的补丁，其余丢弃；
- App 端：续传、换源、校验补丁 sha256、应用前校验旧包 sha256、目标 sha256 与长度。

### 1.7 原生插件协议（`docs/design/native-plugins-protocol.md`，719 行，v1 冻结）

`package.json` 的 `dshGo` 段 → surface（4 种 + 新 surface）→ 宿主服务 `ctx.dshGo` → 路由 `/dsh-go/v1/*` → 效果白名单 → 上限总表。这是 **glibc 生态的真正兑现口**：原生插件不用再自备 bionic 产物。

### 1.8 对 v1 计划的六处勘误

| # | v1 说法 | 复核后 |
|---|---|---|
| 1 | 增量更新用 `bsdiff` | 实际是 **zip 条目级 DSHDLT01**；对 APK 有效，对 `tar.xz` 不适用（见 §1.6 与 P6 的资产更新设计） |
| 2 | dsh-Go「纯协议层不碰 DOM」 | 准确说是 **Flutter 原生 UI + 纯 Dart API 客户端**，不是「协议替代 DOM」；我们只能借鉴「语义契约」思路 |
| 3 | 121 个补丁 | 121 个 **@0.2.2-rc.1**（目标 89 文件），另有历史 pin；总数 122 含 `pins.json` |
| 4 | proot 启动参数照抄 C 方案文档 | C 方案文档的 argv 是**简化版**；生产版还有 `--link2symlink --sysvipc -L -0`、`PROOT_LOADER`、`PROOT_L2S_DIR`、`/apex`、selinux 空目录、shm |
| 5 | 停止用 `Process.destroy()` | 必须 **pidfile + SIGTERM 给 node**，兜底 **SIGQUIT 给 proot**；proot 忽略 SIGTERM |
| 6 | 冷启「+80%」只是估算 | 有实测：1,925 vs 1,072 ms；路径类 syscall 28,100 次是根因；boot-cache 可回收 12~14% |

---

## 二、为什么不混合双模（技术账）

| 维度 | 双模（v1） | 单模（本版） |
|---|---|---|
| 启动代码 | 2 套 argv/环境/停止逻辑 | 1 套 |
| 验收 | 每条判据 ×2（bionic 9/0/1 + proot 四组） | 1 套 |
| 数据迁移 | 两向迁移 + 拼写一致性 | 单向一次 |
| 补丁 | 保留全部 10 个 + 全部锚点 | 删 4 个 bionic 补丁函数（10 → 6）；GUARD 常量 14 个全部保留（均服务模型侧补丁） |
| UI 耦合 | 87 个哈希类名长期存在（bionic 路径要养） | 仍要治理，但只治一套（实测 87 个，其中 client.js 34 个） |
| 包体 | 两套运行时（≈1.06 GB 装机） | 一套（≈809 MB 装机，净省 250 MB） |
| 回滚 | 运行期切换（状态机复杂） | 重装上一版 APK |
| 代价 | — | 冷启 +80%，装机体 **−250 MB**，APK **+25~35 MB** |

**结论**：双模省下的不是风险，是「把风险推迟」；它把一套不确定性变成两套，并且让每次验收都要跑两遍真机。单模的代价可量化、可优化、可接受。

---

## 三、目标形态

```
APK
├─ assets/runtime/rootfs-arm64.tar.xz     Ubuntu 24.04.5 + node 24.22.1 + dsh 0.2.2-rc.1（已打补丁）
├─ assets/runtime/manifest.json           版本/哈希/启动模板/健康判据/停止语义
└─ jniLibs/arm64-v8a/
   ├─ libproot.so          （DT_NEEDED 已改写）
   ├─ libproot-loader.so
   ├─ libtalloc.so
   ├─ libandroid-shmem.so
   └─ libboosandbox.so / liblinkcompat.so （glibc 重编，放 rootfs 内 /usr/local/lib）

files/                                    （运行时目录）
├─ runtime/rootfs/                       解包后 rootfs（含 /root/.dsh 绑定点）
├─ runtime/.rootfs.stamp                  runtimeVersion 字符串
├─ home/.dsh/                            $DSH_HOME（宿主绝对路径，逐字绑定进 guest）
├─ cache/proot-tmp/                      PROOT_TMP_DIR
└─ logs/{app,web,engine}.log
```

启动链（只有一条）：

```
MainActivity.onCreate → 立即 ensureRuntime()（与首帧并行）
  → RootfsInstaller（校验 .stamp / 解包 / 原子 rename）
  → ProotHost.launch(manifest)
       argv = manifest.launch.argv.map { expand(it) }
       env  = manifest.launch.env + 业务 env（TZ / API Key / 代理）
  → 读 stdout token 行 → baseUrl+token
  → health: TCP + 401/带 cookie 200
  → onUiReady
```

---

## 四、里程碑（P0–P7，约 13 周单人）

### P0 · 可行性闸门（✅ 2026-11-09 本机实测通过）

真机 30 分钟内验证三件事，任何一件不过就不要往下走：

```bash
# 1) proot 能在本机跑起来（Android 16 / arm64）
#    取 Termux proot deb + talloc + shmem，解出 usr/bin/proot 与 libexec/proot/loader
/data/user/0/com.dsh.android/files/bin/proot --version
# 2) 能进 rootfs 并执行 glibc 程序
… --rootfs=<rootfs> -0 -L /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/node -v
# 3) 能起 dsh web 并打印 token 行（不接 App，纯 shell）
```

- 判据：`node -v` 输出 `v24.22.1`；`dsh web` 打印 `dsh web: http://127.0.0.1:PORT/?token=…`；进程可被 SIGQUIT 收干净。
- 产出：`_build/proot-feasibility.md`（含 `uname -a`、`/proc/version`、seccomp 状态、实测耗时）。
- **失败预案**：若 seccomp 直接杀 glibc loader，则回退到「bionic + 部分 glibc 插件」不可行 → 本计划终止，改走「官方 linux 预编译 + bionic 重编」路线（另议）。

**实测结果（Xiaomi 25104RADAC / Android 16 / arm64-v8a / kernel 6.1.138-android14）**

```text
proot       5.1.107.102 + talloc 2.5.0 + shmem 0.7（LD_LIBRARY_PATH 兜 RUNPATH）
rootfs      ubuntu-base 24.04.5（29.9 MB gz → 解包约 100 MB）
guest 输出  Linux localhost 6.1.138-android14-... aarch64 GNU/Linux     ← 平台翻面成功
node        v24.22.1（glibc 官方 tarball，未改一个字节）
速度        proot + node -e 0 连跑 3 次 = 731 ms（≈244 ms/次）
残留        测试后 ps 中 p0a 进程数 = 0（--kill-on-exit 正常回收）
```

**三个已踩到的坑（写进 P1 检查表）**

1. **`/storage/emulated/0`（FUSE）不能建符号链接** → `dpkg-deb -x` 解 talloc/proot 会报 `Cannot create symlink … Permission denied`。rootfs 组装必须在 ext4 上做（CI runner、Ubuntu 侧 `/root`、或 `/data/local/tmp`），**工作区只放产物**。
2. **`dpkg-deb -x` 的目标目录要先 `mkdir -p`**，否则报 `failed to create directory`。
3. Ubuntu base **自带** `libstdc++.so.6` 与 `libgcc_s.so.1`，node 直接可跑，不用额外补库。

### P1 · 运行时构建管线（✅ 2026-11-09 落地，commit `331addb5`）

交付：`tools/runtime/build-runtime.sh`（10,406 B）、`tools/runtime/extract.py`（2,234 B）、`tools/runtime/README.md`（2,649 B）。

实测结果：

```text
rootfs 解包       998 MB
rootfs tar.xz     124 MB   sha256 a9593add86df2fde52dc9ba8306fdd0a1f8e8de1e30b6b0a318c58572d576231
jniLibs           libproot.so 264,137 / loader 18,136 / libtalloc.so 33,592 / libandroid-shmem.so 14,432
设备侧            node -v → v24.22.1 ；dsh --version → 0.2.2-rc.1
可复现            连续两次构建 sha256 完全一致
```

两个新坑（已写进 README）：①proot 的 `--link2symlink` 会把 `tar -x` 的硬链接改写成 `.l2s.*` 符号链，打包时炸 `Too many levels of symbolic links` → 改用 `extract.py` 逐条解、硬链接复制成独立文件；②node 官方 tarball 带 85 MB 头文件/文档，运行时用不到，已在脚本里删掉。

**门禁 P1：✅ 通过**（可复现、node/dsh 版本正确、四个 so 就位）。

原始任务清单（保留作对照）：

把 `build-runtime.sh` 的思路移植成我们自己的 `tools/runtime/build-runtime.sh`：

- [ ] 固定版本：`DSH=0.2.2-rc.1`、`NODE=24.22.1`、`UBUNTU=24.04.5`、`PROOT=5.1.107.98`、`SOURCE_DATE_EPOCH=1767225600`
- [ ] 下载即校验：ubuntu-base、node tarball、proot deb、talloc deb、android-shmem deb，五个 sha256 常量写死在脚本里
- [ ] rootfs 组装：解 ubuntu-base → 铺 node → `npm i -g @deepseek-ai/dsh@0.2.2-rc.1` → 应用 diff（P4 产出）→ 放 `/usr/local/lib/{libboosandbox,liblinkcompat}.so` 与 `/usr/local/bin/boo-sandbox-run` → 建 `/root/.l2s`、`/var/lib/dsh-app/{empty,shm}`
- [ ] 打 `rootfs-arm64.tar.xz`（排序、固定 mtime、`--owner=0 --group=0`）
- [ ] 生成 `manifest.json`：版本四元组、rootfs sha256、jniLibs 四个 so 的 sha256、启动模板、健康/停止/文件约定
- [ ] jniLibs 处理：proot deb 解包 → `libproot.so`；`patchelf --replace-needed libtalloc.so.2 libtalloc.so`（或用 dsh-Go 的 `patch-dynstr` 等价实现）
- [ ] Gradle：`useLegacyPackaging = true`、`noCompress += listOf("xz","tar")`、`jniLibs.keepDebugSymbols` 保留四个 so
- **门禁 P1**：`aapt2 dump resources` 能看到四个 so；真机 `nativeLibraryDir` 里 `libproot.so` 可执行（`chmod 755` 由系统完成）；`rootfs.tar.xz` 解包后 `node -v` 正确；两次构建 `rootfs` sha256 一致（可复现）

### P2 · 启动链改造（✅ 2026-11-09 真机通过，commit `a5c0f1a1`）

代码：`RuntimeManifest.kt`（2,345 B）、`ProotHost.kt`（6,647 B）、`ProotProbeActivity.kt`（3,470 B）。

真机探针结果（`files/proot-probe.txt`）：

```text
runtimeVersion=r1-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5-0ff89aba1821
started (+11ms)
tokenUrl=http://127.0.0.1:43665/?token=…
token_after_ms=52199          ← 首次冷启（插件全量加载）
http=401
health=PASS
stopped=true
leftover_node=0
RESULT=PASS
```

过程中修掉的三处真实缺陷：

1. `Process.pid()` 在 Android 上不存在 → 停止改为「SIGTERM node → 等 `--kill-on-exit` → 8 s 后 `destroyForcibly`」，不再依赖 proot pid；
2. 构建脚本把 jniLibs 只放在 `$WORK`，产物目录没有 → 已补 `OUT/<abi>/jniLibs`，并把 `DT_NEEDED` 改写后的 `libproot.so` 一并落盘；
3. 探针 `exported=false` 时 shell 拉不起（AMS 校验 callingPackage）→ 改 `exported=true` + `files/proot-probe.enable` marker 门控，普通应用拉不起有效负载。

已知待办（P5 做）：首启 52 s 太慢，boot-cache + 预热要压到 20 s 内；`DSH_HOME` 目前落在 guest `/root/.dsh`，接线到宿主 `$DSH_HOME` 时要逐字绑定。

原始任务清单（保留作对照）：
- [ ] 删除 `EngineManager` 里 bionic 的 node 启动段（`LD_PRELOAD` 三件套、`termux` 前缀、`proot` 无关的环境变量）
- [ ] `{GUEST_ENV}` 哨兵处理：位于 `/usr/bin/env -i` 之后、`/bin/sh -c` 之前；业务 env（`TZ`、`DEEPSEEK_API_KEY`、代理、`DSH_HOME`）从这里注入
- [ ] binds 插入点：`/usr/bin/env` 之前；额外绑定 `$DSH_HOME:$DSH_HOME`（**逐字相同**，保历史会话 cwd）、workspace、`/sdcard`（按权限）
- [ ] 端口动态分配 + pidfile 语义（`{ROOTFS}/tmp/dsh-web.pid`）
- [ ] 停止：SIGTERM(node) → 5 s → SIGQUIT(proot) → 10 s → `Process.destroyForcibly` 仅作最后手段
- [ ] 健康：TCP + 401/200 双判据；token 正则抓 stdout（不要用日志轮询）
- [ ] 日志：stdout/stderr 双泵，保留 `[web]` 前缀，接入现有 `LogStore`（注意 P2 顺带修掉 r26 那种 flush 问题）
- [ ] 数据迁移：首次启动把旧 `files/engine` 下的 `.stamp` 读出来，写进新 `.rootfs.stamp`；旧目录保留一代后清理
- **门禁 P2**：冷启 3 次稳定出 token；`http=401`；杀进程后无孤儿 node（`ps -A | grep node` 为空）；强杀后再次启动不残留 pidfile；`verify --tools` 9/0/1

### P3 · 原生层与沙箱（✅ 2026-11-09 真机 12 PASS / 0 FAIL）

三个 C 层已在 rootfs 内用 gcc 重编（`apply-glibc-patches.py` 幂等打补丁）：

```text
boo-sandbox-run        71,304 B   /usr/local/bin/
libboosandbox.so       73,344 B   /usr/local/lib/
liblinkcompat.so       70,992 B   /usr/local/lib/
```

官方 linux-arm64 预编译补齐（`--ignore-scripts` 不会装 optionalDependencies）：

```text
@deepseek-ai/node-addon-system-linux-arm64   flock     ✅
@img/sharp-linux-arm64 + libvips-linux-arm64 sharp     ✅ vips 8.18.7
node-pty/prebuilds/linux-arm64               node-pty  ✅
node:sqlite                                  sqlite    ✅
```

真机 `verify-c.sh` 汇总 **PASS=12 / FAIL=0**：

```text
① process.platform=linux                       ✅
② flock / sharp / node-pty / node:sqlite       ✅✅✅✅
③ workspace 内写放行 / 外写拒绝 / mkdirat 拒绝   ✅✅✅
   readonly 拒绝写 / /dev/null 可写 / 未知flag=125 ✅✅✅
   link() 转译（ENOSYS）                        ✅
④ headless 端到端                              （跳过：需已配置模型）
```

关键发现：`verify-c.sh` 的 ② 用 `node -e require(...)`，模块解析按 **cwd** 走；引擎装在 `/opt/dsh`，必须带 `NODE_PATH=/opt/dsh/node_modules`（已写进 manifest 的 guest env）。不带 NODE_PATH 时 ② 会误报「缺预编译」。

原始任务清单（保留作对照）：

- [ ] `boo-sandbox-run.c` / `boosandbox.c` / `linkcompat.c` 在 Ubuntu 24.04 内用 gcc 重编（C 方案文档已列出补丁：`linkcompat` 认 `ENOSYS`；`boosandbox` 补 8 个符号：`openat64` `creat64` `__open_2` `__open64_2` `__openat_2` `__openat64_2` `freopen` `freopen64`）
- [ ] 用 `tools/apply-glibc-patches.py`（已存在）做幂等打补丁，`--check` 进 CI
- [ ] overlay 三行：`sandbox.runnerCommand` + `runnerFailureSignatures`、`session-query-sqlite.openAt: first-search`、`plugin-manager.registry/fallbackRegistries`
- [ ] 沙箱边界复验（C 方案文档的四组）：readonly 写 `/tmp` 拒绝、workspace-write 内成功、ws 外拒绝、`mkdirat` 逃逸拒绝、`/dev/null` 可写、python `open` 内外行为、`sed -i` 拒绝
- **门禁 P3**：`tools/verify-c.sh` 四组全绿（平台翻面 / 官方预编译 / 沙箱边界 / 端到端）

### P4 · 补丁工程化 + UI 契约（🟢 补丁 6/6 已迁构建期；剩 bionic 删除与 UI 迁移）

**已完成：构建期 diff + 双哈希 pin（6 个补丁）**

- `tools/runtime/make-patches.py`：从 `EngineManager.kt` 常量自动生成 `.diff` + `pins.json`（before/after 双 sha）
- `tools/runtime/apply-patches.py`：三态应用器（already / apply / mismatch→exit 1）
- `runtime/patches/`：六个 diff —— `deepseek-tool-order`、`pi-ai-tool-call-id`、`llm-tool-call-id-fallback`、`attachment-durability`、`fail-loud-exit`、`image-media-type` + `pins.json`
- `build-runtime.sh` 在 npm 安装后自动应用，任一 mismatch 即构建失败

验证：

```text
--check        → WANT ×3
首次 apply     → 已应用（本次）×3
再次 apply     → 已应用 ×3（幂等）
篡改一个字节   → FAIL + rc=1（门禁有效）
产物 tar 内    → 三个 Android 注释锚点各命中 1 次
```

**已完成：UI 契约审计基线**

- `tools/ui-contract/audit.mjs`：统计哈希类名唯一数 / 分布，支持 `--json` / `--write-baseline` / `--max`
- 基线：**60 个唯一类名 / 4 个文件**（`baseline.json`），门禁锁 57；`--dead` = 0
- `tools/ui-contract/README.md`：三级选择器（`data-*` → ARIA → contract）与迁移顺序

验证：`--max 60` 通过、`--max 59` 返回 1；`--dead` rc=0。

> 早期 159 是正则误报（Kotlin 常量被当成哈希类名）；过滤「前缀大小写混合」后真实债务 60。

**已完成：contract 抽取**

- `tools/ui-contract/extract.mjs`：扫 85 个插件 `lib/client.js`，产出 **1431** 个哈希类名（656 带 `data-*`、96 带 `aria-*` 候选），写入 `contract.json`
- 覆盖度：我方 `client.js` 的 60 个引用里 **59** 个能在 contract 中找到
- **首个死选择器**：`bOPqQW_root` 在引擎里已不存在（只剩 `_anchor/_pill/_label/_sep`）——静默失效，已记录，`--dead` 检查待做

**已完成：CI 门禁 + npm 回退**

- `apk.yml` 新增「UI 契约门禁」步骤：`audit --dead` + `audit --max 57`
- `build-runtime.sh` 的 npm 安装按 `npmmirror → npmjs → 离线缓存` 三级回退

**首轮下降**：60 → 57（清掉 3 个只出现在注释里的哈希引用）。

**剩余**：①4 个 bionic 补丁删除（推迟到 P5 回归）；②`patchFailLoudExit` 的第 2 步（`profile-boot-<hash>.js`，文件名随构建变）仍留运行期；③`client.js` 59 个哈希引用逐条迁 `data-*`/contract。

原始任务清单（保留作对照）：

**P4a 补丁瘦身（先减后搬）**

对照本工程 10 个补丁函数，逐条判定去留（初判，实施时以真机为准）：

| 补丁 | 判定 | 理由 |
|---|---|---|
| `patchFlockPlatform` | **删** | glibc 有原生 flock，官方 linux 分支直接可用 |
| `patchTerminalShell` | **删/降级** | guest 内是 bash，不再需要 `/system/bin/sh` 适配 |
| `patchProcessInspector` | **删/降级** | guest 有 `/proc`，`ps` 走 linux 分支 |
| `patchImageMediaType` | **复核** | 若为 sharp/wasm 适配则可删（glibc 用官方 `@img/sharp-linux-arm64`） |
| `patchAttachmentDurability` | 保留 | 原子写/rename 语义与平台无关 |
| `patchFailLoudExit` | 保留 | 崩溃可观测性 |
| `patchLlmDeepseekToolOrder` | 保留 | 模型侧行为 |
| `patchLlmPiAiToolCallId` | 保留 | 模型侧行为 |
| `patchLlmToolCallIdFallback` | 保留 | 模型侧行为 |
| `patchPresetCordisPersona` | 保留 | 产品功能 |

目标：**补丁函数 10 → 6**；`GUARD` 常量 14 个保持不变（都服务保留的模型侧补丁）。

**P4b 构建期 diff + pin 门禁**

- [ ] `runtime/patches/*.diff`（6 个），每个带中文注释头与 purpose
- [ ] `runtime/patches/pins.json`：`{patch: {dshVersion: {file: {before, after}}}}`
- [ ] `tools/runtime/apply-patches.py` 三态：`already-applied`（sha==after）/ `apply`（sha==before → 打 → 校验 after）/ `mismatch`（打印上下文 + exit 1）
- [ ] CI 步骤：`apply-patches.py --check`；构建期 `--apply`；单独 job 校验「每个 diff 都被 pin 覆盖」
- [ ] 运行期只保留 `GUARD` 锚点自检，miss 从 `warn` 升级为 `State.Failed` + 救援横幅

**P4c UI 契约**

- [ ] `tools/ui-contract/extract.mjs`：从官方前端 dist 抽 `hash → 语义` 映射 → `runtime/ui-contract.json`
- [ ] polyfill / mobile-ui 改三级选择器：`data-*` → ARIA → contract
- [ ] `tools/ui-contract/audit.mjs`：CI 里禁止出现 `\.[A-Za-z0-9]{6,8}_[A-Za-z0-9]{2,5}` 形态选择器
- **门禁 P4**：①6 个 diff 全部 pin 且构建成功；②改坏一个 anchor → CI 红；③audit 0 命中；④四类 UI 缺陷（抽屉/按钮/面板页/多模态）真机复验通过

### P5 · 冷启动与稳定性（1.5 周）

- [ ] 移植 `boot-cache.mjs` 思路：`dsh web` 启动前预加载路径缓存（拦截 `fs.statSync/realpathSync/openSync` 的重复探测）
- [ ] 点开即拉起：`MainActivity.onCreate` 与首帧并行 `ensureRuntime()`
- [ ] 常驻：`EngineService` 前台服务 + 进程保活（可选「开机预热」开关）
- [ ] 首帧兜底：沿用 r28 的 `[I]` 日志口径，阈值 1500 ms 不动
- [ ] 崩溃救援：连续失败 2 次 → 自动进安全模式（`--profile safe`，插件全关）→ 第三次失败提示重装运行时
- [ ] 观测：`engine.ready`、`token.printed`、`http.first-request` 三个时间点写进 `app.log`，用于对比 bionic 基线
- **门禁 P5**：①冷启中位数 ≤ bionic 基线 × 1.35（boot-cache + 预热后）；②连续 10 次冷启无救援；③`verify` 9/0/1

### P6 · 分发与更新（1.5 周）

- [ ] 资产拆分：`rootfs` 走「首装内置 or 首次下载」二选一（内置包体 ~200 MB；下载包 ~130 MB xz）
- [ ] APK 增量：照搬 DSHDLT01（80 B 头 + COPY/DATA + END），只保留 < 60% 的补丁；`release_assets.py` 等价物生成 `update.json`
- [ ] 运行时热修：`runtimeVersion`（`rev-dsh…-node…-ubuntu…-inputs12`）驱动，首次启动校验 `.stamp`，不匹配则重新解包
- [ ] 原子替换：`rootfs.staging-<version>-<pid>` → 校验 → `rename`；失败保留旧目录
- **门禁 P6**：①`r29 → r30` 差分包 < 60% 整包；②断点续传后 sha256 一致；③旧版 APK 不认识 `patches` 字段时正常下整包；④运行时版本不匹配自动重解包

### P7 · 生态兑现（2 周，可延后）

- [ ] 原生插件协议 v1（借 dsh-Go 的 `dshGo` 清单 + `ctx.dshGo` + `/dsh-go/v1/*` 路由 + 效果白名单 + 上限表）
- [ ] 远程协议矩阵（mDNS → WebRTC → TURN，X25519 + AES-GCM）
- [ ] i18n（`values-en`）与快捷方式/磁贴
- **门禁 P7**：原生插件能装、能跑、能被上限表挡住；远程三链路连通；英文无漏出

---

## 五、关键实现片段

### 5.1 ProotHost 启动（Kotlin）

```kotlin
class ProotHost(
    private val ctx: Context,
    private val manifest: RuntimeManifest,
) {
    private var proc: Process? = null

    fun launch(extraEnv: Map<String, String>, port: Int): Process {
        val rootfs = File(ctx.filesDir, "runtime/rootfs")
        val tmp = File(ctx.cacheDir, "proot-tmp").apply { mkdirs() }
        val vars = mapOf(
            "{NATIVE_LIB_DIR}" to ctx.applicationInfo.nativeLibraryDir,
            "{ROOTFS}" to rootfs.canonicalPath,
            "{TMP}" to tmp.absolutePath,
            "{FILES_DIR}" to ctx.filesDir.absolutePath,
            "{PORT}" to port.toString(),
        )
        fun expand(s: String) = vars.entries.fold(s) { acc, (k, v) -> acc.replace(k, v) }

        val argv = ArrayList<String>()
        var bindsPlaced = false
        var envPlaced = false
        for (raw in manifest.launchArgv) {
            val arg = expand(raw)
            when {
                !bindsPlaced && arg == "/usr/bin/env" -> {
                    manifest.binds.forEach { argv += "-b"; argv += expand(it) }
                    argv += "-b"; argv += "${ctx.filesDir}/home/.dsh:${ctx.filesDir}/home/.dsh"
                    bindsPlaced = true
                    argv += arg
                }
                arg == "{GUEST_ENV}" -> {
                    extraEnv.forEach { (k, v) -> argv += "$k=$v" }
                    envPlaced = true
                }
                else -> argv += arg
            }
        }

        val pb = ProcessBuilder(argv).directory(ctx.filesDir)
        pb.environment().apply {
            clear()
            put("PATH", "/system/bin:/system/xbin")
            put("HOME", ctx.filesDir.absolutePath)
            put("TMPDIR", tmp.absolutePath)
            put("PROOT_TMP_DIR", tmp.absolutePath)
            put("ANDROID_ROOT", System.getenv("ANDROID_ROOT") ?: "/system")
            put("ANDROID_DATA", System.getenv("ANDROID_DATA") ?: "/data")
            put("PROOT_LOADER", "${ctx.applicationInfo.nativeLibraryDir}/libproot-loader.so")
            put("PROOT_L2S_DIR", "$rootfs/root/.l2s")
            put("LD_LIBRARY_PATH", ctx.applicationInfo.nativeLibraryDir)
            manifest.launchEnv.forEach { (k, v) -> put(k, expand(v)) }
        }
        return pb.start().also { proc = it }
    }

    fun stop() {
        val pidFile = File(ctx.filesDir, "runtime/rootfs/tmp/dsh-web.pid")
        val nodePid = runCatching { pidFile.readText().trim().toInt() }.getOrNull()
        nodePid?.let { runCatching { Os.kill(it, OsConstants.SIGTERM) } }
        repeat(50) { if (!alive(nodePid)) return@repeat }        // 5 s
        proc?.let { runCatching { Os.kill(it.pid(), OsConstants.SIGQUIT) } }  // proot ignores SIGTERM
    }

    private fun alive(pid: Int?): Boolean =
        pid != null && File("/proc/$pid").exists()
}
```

### 5.2 manifest 结构（我们自己的）

```json
{
  "runtimeVersion": "r1-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5-3f9a1c2b7d40",
  "abi": "arm64-v8a",
  "rootfs": { "asset": "runtime/rootfs-arm64.tar.xz", "sha256": "…", "bytes": 0 },
  "jniLibs": {
    "libproot.so": { "sha256": "…" },
    "libproot-loader.so": { "sha256": "…" },
    "libtalloc.so": { "sha256": "…" },
    "libandroid-shmem.so": { "sha256": "…" }
  },
  "launch": {
    "argv": [
      "{NATIVE_LIB_DIR}/libproot.so", "--kill-on-exit", "--link2symlink", "--sysvipc", "-L", "-0",
      "--rootfs={ROOTFS}", "--cwd=/root",
      "-b", "/dev", "-b", "/proc", "-b", "/sys", "-b", "/system", "-b", "/apex",
      "-b", "{ROOTFS}/var/lib/dsh-app/empty:/sys/fs/selinux",
      "-b", "{ROOTFS}/var/lib/dsh-app/shm:/dev/shm",
      "/usr/bin/env", "-i",
      "HOME=/root", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LANG=C.UTF-8", "TERM=xterm-256color", "TMPDIR=/tmp",
      "{GUEST_ENV}",
      "/bin/sh", "-c", "echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --patch /root/.dsh/android-glibc.patch.yml --host 127.0.0.1 --port {PORT} --no-open"
    ],
    "env": {
      "PROOT_LOADER": "{NATIVE_LIB_DIR}/libproot-loader.so",
      "PROOT_TMP_DIR": "{TMP}",
      "PROOT_L2S_DIR": "{ROOTFS}/root/.l2s",
      "LD_LIBRARY_PATH": "{NATIVE_LIB_DIR}"
    }
  },
  "tokenLine": { "regex": "^dsh web: (http://127\\.0\\.0\\.1:[0-9]+/)\\?token=([A-Za-z0-9_-]+)" },
  "health": { "tcp": true, "unauthStatus": 401, "authStatus": 200 },
  "stop": { "pidFile": "{ROOTFS}/tmp/dsh-web.pid", "graceful": "SIGTERM node", "force": "SIGQUIT proot" }
}
```

### 5.3 补丁应用器（Python，三态）

```python
#!/usr/bin/env python3
"""apply-patches.py --prefix <rootfs>/opt/dsh --dsh-version 0.2.2-rc.1 --patches runtime/patches [--check]"""
import hashlib, json, pathlib, subprocess, sys

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def main() -> int:
    root, ver = pathlib.Path(ARGS.prefix), ARGS.dsh_version
    pins = json.loads((pathlib.Path(ARGS.patches) / "pins.json").read_text())["patches"]
    bad = 0
    for diff, by_ver in sorted(pins.items()):
        if ver not in by_ver:
            print(f"[SKIP] {diff}: no pin for {ver}"); continue
        for rel, ph in by_ver[ver].items():
            f = root / rel
            if not f.is_file():
                print(f"[FAIL] {diff}: missing {rel}"); bad += 1; continue
            cur = sha(f)
            if cur == ph["after"]:
                print(f"[OK]   {diff}: already applied"); continue
            if cur != ph["before"]:
                print(f"[FAIL] {diff}: {rel} sha mismatch\n  got {cur}\n  want {ph['before']}"); bad += 1; continue
            if ARGS.check:
                print(f"[WANT] {diff}: applicable"); continue
            subprocess.run(["patch", "-p1", "--no-backup-if-mismatch", "-i",
                            str(pathlib.Path(ARGS.patches) / diff)], cwd=root, check=True)
            got = sha(f)
            if got != ph["after"]:
                print(f"[FAIL] {diff}: post sha {got} != pin"); bad += 1
            else:
                print(f"[OK]   {diff}: applied")
    if bad:
        print(f"\n{bad} patch problem(s) — build must fail"); return 1
    return 0
```

### 5.4 boot-cache（思路，非源码）

```text
在 dsh 启动前 --import 一段 preload：
  · 拦截 fs.statSync / fs.realpathSync / fs.realpathSync.native / fs.openSync
  · 对 /opt/dsh/node_modules 下的只读树，首次结果写入内存 Map（进程内，不落盘）
  · 命中即返回，失败结果（ENOENT）也缓存（DSH 启动期 5,168 次 statx 失败）
  · 仅 `dsh web` 加载；`dsh plugin` / 安全模式不加载；开关 DSH_BOOT_CACHE=0
实测收益：warm -14%、cold -12%（dsh-Go 模拟器数据）
```

---

## 六、验收矩阵

| 里程碑 | 判据 | 命令 |
|---|---|---|
| P0 | proot 起 glibc node | 见 §4 P0 三行 |
| P1 | 可复现 + 可执行 | 两次构建 sha256 一致；`node -v` = v24.22.1 |
| P2 | 启动链 | token 行 + `http=401` + 无孤儿 + `verify` 9/0/1 |
| P3 | 沙箱 | `verify-c.sh` 四组全绿 |
| P4 | 补丁/契约 | anchor 破坏 → CI 红；audit 0 命中 |
| P5 | 冷启/稳定 | 中位数 ≤ bionic × 1.35；10 次冷启无救援 |
| P6 | 更新 | 差分包 < 60%；校验失败拒绝启用 |
| P7 | 生态 | 原生插件可装可跑；远程三链路 |

**每轮固定复跑**：`verify-engine-upgrade.sh --tools`（9/0/1）、冷启 3 次、APK 体积、`dumpsys package` 安装时间。

---

## 七、风险与处置

| 风险 | 概率 | 影响 | 处置 |
|---|---|---|---|
| P0 不过：Android 16 杀 glibc loader | 中 | 计划终止 | P0 先做；失败则改「官方 linux 预编译 + bionic 重编」另案 |
| 冷启 +80% 体感明显 | 高 | 体验 | boot-cache + 点开即拉起 + 常驻；对外口径写清楚 |
| 存储 | 高 | 装机门槛 | **实测净省 ~250 MB**（1.06 GB → 809 MB），不是增加 |
| 补丁删多了 | 中 | 功能回归 | 每删一个补丁，跑一次对应用例（flock/终端/进程/图片） |
| UI 契约抽取漏 | 中 | 局部样式失效 | 三级选择器 + 不注入降级 + CI 审计 |
| `--link2symlink` 的 `.l2s` 被清 | 低 | 启动失败 | 解包时创建并校验；启动前 `isDirectory` 断言 |
| proot 忽略 SIGTERM 导致孤儿 | 高 | 内存泄漏 | pidfile + SIGQUIT；启动前扫孤儿（读 `PROOT_TMP_DIR` 归属） |
| 根目录路径过长（AF_UNIX 108） | 中 | 终端/服务起不来 | socket 一律放 `/tmp`；rootfs 路径保持短 |

**回滚**：装回上一版 APK（同签名，`versionCode` 递减不允许 → 用 `adb install -r -d` 或卸载重装；历史 `$DSH_HOME` 保留）。

---

## 八、工时

| 阶段 | 内容 | 人日 |
|---|---|---|
| P0 | 可行性闸门 | 2 |
| P1 | 运行时构建管线 | 10 |
| P2 | 启动链 | 10 |
| P3 | 原生层与沙箱 | 8 |
| P4 | 补丁 + UI 契约 | 10 |
| P5 | 冷启与稳定性 | 8 |
| P6 | 分发与更新 | 8 |
| P7 | 生态（可延后） | 10 |
| 合计 | | **66 人日**（≈13 周单人 / 7 周双人） |

**顺序**：P0 → P1 → P2 → P3 → P4 → P5 → P6 →（P7）。

---

## 九、P0 执行记录（已完成）与下一步

以下命令已在本机跑过，结果见 `_build/proot-feasibility.md`：`proot-ok` / `aarch64 GNU/Linux` / `v24.22.1` / 3 次 731 ms / 零残留。

**下一步 = P1 第一件事**：把上面的手工流程固化成 `tools/runtime/build-runtime.sh`，在 ext4 上组装 rootfs，产出 `rootfs-arm64.tar.xz` + `manifest.json` + `jni/arm64-v8a/` 四个 so（含 `patchelf --replace-needed libtalloc.so.2 libtalloc.so`）。

```bash
# P0-1 取构件（Termux stable 仓库；版本已核对到 2026-11-09）
cd '/storage/emulated/0/MT2/apks/deepseek harness'
mkdir -p _build/runtime/p0 && cd _build/runtime/p0
B=https://packages.termux.dev/apt/termux-main
curl -fLO "$B/pool/main/p/proot/proot_5.1.107.102_aarch64.deb"
curl -fLO "$B/pool/main/libt/libtalloc/libtalloc_2.5.0_aarch64.deb"
curl -fLO "$B/pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb"
sha256sum -c <<'EOF'
10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030  proot_5.1.107.102_aarch64.deb
556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7  libtalloc_2.5.0_aarch64.deb
0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6  libandroid-shmem_0.7_aarch64.deb
EOF

# P0-2 解包 + 摆成 jniLibs 形态（talloc 改名 + 改 DT_NEEDED）
for d in *.deb; do dpkg-deb -x "$d" "x/${d%%_*}"; done
T=x/proot/data/data/com.termux/files/usr
mkdir -p jni/arm64-v8a
cp "$T/bin/proot"                  jni/arm64-v8a/libproot.so
cp "$T/libexec/proot/loader"       jni/arm64-v8a/libproot-loader.so
cp x/libtalloc/data/data/com.termux/files/usr/lib/libtalloc.so.2.5.0 jni/arm64-v8a/libtalloc.so
cp x/libandroid-shmem/data/data/com.termux/files/usr/lib/libandroid-shmem.so jni/arm64-v8a/
patchelf --replace-needed libtalloc.so.2 libtalloc.so jni/arm64-v8a/libproot.so
readelf -d jni/arm64-v8a/libproot.so | grep -E 'NEEDED|RUNPATH'   # 应看到 libtalloc.so / libandroid-shmem.so

# P0-3 最小 rootfs（Ubuntu base + glibc node）
curl -fLO https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz
mkdir -p rootfs && tar -xzf ubuntu-base-24.04.5-base-arm64.tar.gz -C rootfs
curl -fLO https://npmmirror.com/mirrors/node/v24.22.1/node-v24.22.1-linux-arm64.tar.xz
tar -xJf node-v24.22.1-linux-arm64.tar.xz -C rootfs/usr --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
mkdir -p rootfs/root/.l2s rootfs/var/lib/dsh-app/empty rootfs/var/lib/dsh-app/shm

# P0-4 推到真机跑（/data/local/tmp 下名字任意；只有 nativeLibraryDir 才要求 lib*.so）
cp -a rootfs /data/local/tmp/p0-rootfs
cp jni/arm64-v8a/libproot.so        /data/local/tmp/p0-proot
cp jni/arm64-v8a/libproot-loader.so /data/local/tmp/p0-loader
cp jni/arm64-v8a/libtalloc.so       /data/local/tmp/libtalloc.so
cp jni/arm64-v8a/libandroid-shmem.so /data/local/tmp/libandroid-shmem.so
chmod 755 /data/local/tmp/p0-proot /data/local/tmp/p0-loader

LD_LIBRARY_PATH=/data/local/tmp PROOT_LOADER=/data/local/tmp/p0-loader \
  /data/local/tmp/p0-proot --kill-on-exit --link2symlink -0 \
  --rootfs=/data/local/tmp/p0-rootfs -b /dev -b /proc -b /sys --cwd=/root \
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp \
  /bin/echo proot-ok

# 同一个 rootfs 里跑 glibc node（判据：v24.22.1）
LD_LIBRARY_PATH=/data/local/tmp PROOT_LOADER=/data/local/tmp/p0-loader \
  /data/local/tmp/p0-proot --kill-on-exit --link2symlink -0 \
  --rootfs=/data/local/tmp/p0-rootfs -b /dev -b /proc -b /sys --cwd=/root \
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp \
  /usr/bin/node -v
```

P0 三行全绿后，再开 P1 的构建管线。**P0 不过，后面一个字都不要写。**
