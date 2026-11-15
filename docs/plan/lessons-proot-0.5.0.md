# 0.5.0 单运行时 PRoot：踩坑与修复全记录

> 范围：`feat/proot-0.5.0-x64` 从 S4b 到 S8 的全过程（2026-11-12 ~ 11-15）。
> 只写**真机上真实撞到过**的问题，每条都带「症状 → 根因 → 修法 → 判据」。
> 目的不是记流水账，而是让下一个人（或下一次的我）不在同一个位置再摔一次。

---

## 零、总纲：这个项目反复出现的一类缺陷

**「结论与它描述的对象不是同一个」** —— 日志/界面给出一句判断，而那句话说的东西
和真实情况并不是一回事。本会话里它至少换了 12 种外衣：

| 外衣 | 真实情况 |
|---|---|
| 「引擎启动超时」 | 进程在 6.8 s 就退出了，只是 `await` 被 EOF 提前唤醒 |
| 「隔离失败」 | 那个文件已经不在，`isFile` 判据对目录返回 false |
| 「体检查过、没问题」 | `--dump-config` 看不见 `apply()` 期异常 |
| 「救援模式已就绪」 | tier 记的是 rescue，实际跑的还是 web profile |
| 「安全模式已重解包」 | 删的是 `engine/.stamp`，而 0.5.0 根本没有 `engine/` |
| 「试启动成功」 | 探测把用户正在跑的引擎杀了，`ready` 是上一个实例的状态 |
| 「修复完成、数据无损」 | 修复顺手把 dev-env（git/python3/curl）一起带走 |
| 「网络不可达」 | 包里的 `resolv.conf` 是**构建机**的，设备上所有 DNS 都失败 |
| 「发图失败（仅支持 PNG/JPG/WebP）」 | 是 `@img/colour` 被裁剪误删，sharp 连 require 都过不去 |
| 「离线目录」 | 引擎 fetch 全失败，市场回落到内置目录 |
| 「已隔离插件」 | 只摘了清单名，`node_modules` 里的包还在被扫回来 |
| 「AVD 里 PRoot 不可用」 | 是模拟器的 ptrace 限制，与代码无关 |

**可执行的自我检查**：任何一条新写的判据，先问「它描述的时机/对象，和我以为的是同一个吗？」
凡是「先广播状态、后落盘证据」的顺序，一律反过来（见 §2.6）。

---

## 一、运行时与网络

### 1.1 rootfs 里 `/etc/resolv.conf`、`/etc/hosts` 是 0 字节

- 症状：引擎 `fetch` 抛 `fetch failed`；`dns.lookup` → `EAI_AGAIN`；登录、插件市场、模型列
  表全挂。`/etc/ssl/certs` 与 `usr/share/ca-certificates` 根本不存在。
- 根因：ubuntu-base 的这两个文件是空占位；PRoot 里没有 Android 的 netd resolver。
- 修法：`build-runtime.sh` 写入公共 DNS + `127.0.0.1 localhost`；解 `ca-certificates` deb 并生成
  `ca-certificates.crt`；`ProotHost` 注入 `SSL_CERT_FILE / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE`。
- 判据：guest 内 `node -e "fetch('https://registry.npmmirror.com')"` → 200。

### 1.2 构建机的 `resolv.conf` 被打进镜像（本次最痛）

- 症状：登录「账号资料暂不可用」、插件市场「网络不可达…已回落到离线目录：`fetch failed`」。
  引擎日志是 `errorCode:'no-response'`（连 DNS 都没到，不是 HTTP 错误）。
- 根因：dev-tools 步骤为了 chroot apt，`cp /etc/resolv.conf` 进 rootfs，**装完没还原** →
  镜像里是 `nameserver 127.0.0.53` + `search us-west-2.compute.internal`；设备上没有那个解析器。
  而客户端只在文件**为空**时才重写（为了尊重用户自定义），于是把坏值放行。
- 修法：①构建期 apt 之后强制还原公共 DNS；②`verify.py` 断言「不得含 `127.0.0.53`/`127.0.0.1`/
  `compute.internal`，且必须含公共 nameserver」；③客户端 `RuntimeFiles.needsPublicDns()`
  对「空 / 已知坏值 / 没有可用 nameserver」一律重写（老安装自愈，无需重装）。
- 判据：真机 `cat rootfs/etc/resolv.conf` 正确 + 引擎 `model listing … loaded 2 model(s)`。
- **教训**：*构建期为了跑工具而临时改写的运行时文件，必须在同一步里还原，并由出包断言兜住。*
  同类：`/etc/hosts`、`/var/lib/apt/lists`、`qemu-*-static`、`sources.list` 的构建机域名。

### 1.3 `@img/colour` 被「平台裁剪」误删

- 症状：`Cannot find module '@img/colour'`，require stack 指向 `sharp/dist/colour.cjs` ⇒
  **发图必失败**（不是「少个格式」）。
- 根因：裁剪白名单只留 `@img/sharp-<os>-<cpu>` 与 `sharp-libvips-*`，把**纯 JS** 的
  `@img/colour` 一起删了；而 sharp ≥0.34 在 require 期无条件加载它。
- 修法：裁剪只针对 `sharp-*` / `sharp-libvips-*` 里的异平台目录；`verify.py` 断言
  `@img/colour/package.json` 存在。
- 判据：guest `require('sharp')` + 8×8 PNG 编码成功；进一步跑「1600×1200 JPEG → 1024 webp +
  320 thumb」全链路。

### 1.4 pnpm 与 dev-env

- pnpm 必须在镜像里（`/usr/local/bin/pnpm`），`verify.py` 断言；裁剪时删掉 darwin/win32 原生件。
- `dsh-env.mjs` / `check-devenv.mjs` 必须随 APK 解到 `filesDir` 并被 `ProotHost` 绑进 guest，
  否则「开发环境」面板读不到状态（旧代码指向已删除的 `files/termux/usr/bin/node`）。

### 1.5 把 `git` / `python3` / `curl` 放进镜像（S8 前置）

踩了五连坑，按顺序：

| # | 坑 | 修法 |
|---|---|---|
| 1 | runner 无 `qemu-user-static`（`E: has no installation candidate`） | 用 `docker/setup-qemu-action` 注册 **binfmt_misc**（`F` 标志），不在镜像里放 qemu |
| 2 | chroot 里 apt-key 报 `cannot create /dev/null: Permission denied` | `mount --bind /dev` + `mount -t proc` |
| 3 | ubuntu-base 无 gpgv ⇒ 源「not signed」 | `--allow-unauthenticated` + 允许未签名仓库（二进制由 verify 兜底） |
| 4 | 用 `umount -l` 打包 ⇒ `tar: Exiting with failure status` | 必须真 `umount` 并 `mountpoint -q` 复查后再 tar |
| 5 | apt 的 root 属主文件（`/etc/ssl/private` 0700）⇒ 非 root tar 读不到 | 装完 `chown -R $(id -u):$(id -g)` 整棵树 |
| 6 | x86_64 rootfs 走 `ports.ubuntu.com` ⇒ apt rc=100 | 按 ABI 选源：arm64→ports，x86_64→archive |
| 7 | 体积 143 → 189 MB | 清 `share/doc|man|info` + `__pycache__`，回到 187 MB |

---

## 二、进程与生命周期

### 2.1 「引擎启动超时」其实是启动即崩

- `readyLatch` 会在 stdout EOF 时 `countDown`，而 `proc.isAlive` 在 reap 之前仍是 true。
- 修法：判据从「进程还活着吗」改成「等满了没有」；文案区分「超时 / 打印 URL 前就结束」。
- 教训：*超时类判断必须基于「等到什么时候」，而不是「对象现在什么状态」。*

### 2.2 停止被当成失败

`stop()` 主动 destroy ⇒ stdout EOF ⇒ 走进失败分支，`RescueBoot.recordFailure` +1，
真机上直接把「切 profile」变成「用户配置被推开」。修法：判据加 `userStopped || process !== proc`。

### 2.3 全局按 cmdline 杀 guest node

- 旧 `ProotHost.stop()` 遍历 `/proc/*/cmdline` 找 `rootfs/usr/bin/node` 并 kill ——
  **试启动会顺手杀掉用户正在用的引擎**（0.5.0 只有一套 rootfs，marker 命中所有人）。
- 修法：每次运行独立 pidfile（`dsh-web-<runId>.pid`）；停止只作用于本进程树
  （PID + `starttime` 防复用），SIGTERM → SIGQUIT → SIGKILL。
- 判据：活引擎跑着发 `try-boot`，探测结束后 `ps` 里只剩主引擎的 proot。

### 2.4 并发启动与「旧的一轮复活」

Activity 重建 / 前台服务 / 救援信箱都会调 `start()`。修法：`Mutex` 串行化 +
`startGeneration` 代际；`stop()` 立刻把代际 +1，任何在途启动在下一个检查点自行退出。

### 2.5 pidfile/端口互相踩

一个 manifest 一个 `dsh-web.pid` ⇒ 两个 host 抢同一份。修法同 2.3（runId），并 `--port 0`。

### 2.6 失败记录晚于状态广播

`State.Failed` 会**同步**唤醒 main 线程里的 `shouldAutoEnterSafeMode()`，而记录还写在后面 ⇒
判定永远少一次，L3 整体晚一轮。修法：**先落盘（`RescueBoot.recordFailure` + CrashRecorder +
EventLog），再广播**。

### 2.7 密钥出现在 `ps`

`extraEnv` 展开进 guest argv ⇒ shell/root 侧 `ps` 能看到 API key。修法：写
`$DSH_HOME/.proot-env-<runId>`（0600，`stop()` 即删），启动脚本 `. '<file>'` 再 exec。

---

## 三、救援与安全模式（0.5.0 的语义变化）

### 3.1 S4c 删 bionic 时把整段编排一起删了

`startProot()` 只剩「解包 → 起进程 → 等 token」，于是：无 `ensureRescueProfile` /
`rescueAvailable` 永远 false、无层级重读、无 `ensureRescuePrompt`、四个命令信箱一个没起、
失败不落盘、gateway 不检测、health 不校验、无退出监视。**表现是「能起，但没有任何自愈能力」。**
修法：按 pre-S4c 的 `start()` 逐项接回，并把 guest 路径换掉（见 §4）。

### 3.2 安全模式删的是不存在的戳

`enterSafeMode()` 删 `engine/.stamp` —— 0.5.0 没有 `engine/`，等于什么都没做。
修法：`RootfsInstaller.invalidate()` 删 `.rootfs.stamp`，下次 ensure 重新解包；
`rebuildEngine()` 直接「invalidate + ensure + 复检」。

### 3.3 `isWithinManagedRoots` 不认 rootfs

体检把 `/opt/dsh/...` 当外部路径丢掉 ⇒ 修不了。修法：加入 `rootfsDir`，并把 `/opt/dsh`
映射到 `<files>/runtime/rootfs/opt/dsh`。

### 3.4 救援 profile 清单损坏 ⇒ 每次启动都失败

修法：`ensureRescueProfile()` 校验 `package.json` 的 bundles 恰好是核心两条，坏了先
`quarantine`（改名不删）再重建。

---

## 四、路径与数据

### 4.1 宿主绝对路径 vs guest 路径

`$DSH_HOME`、workspace 一律**按原绝对路径**绑定进 guest（不是绑到 `/root/.dsh`），
否则 EngineManager 写的所有 overlay / 插件目录 / 会话索引路径全部失效。
只有沙箱 runner 是例外：guest 里是 `/usr/local/bin/boo-sandbox-run`。

### 4.2 数据迁移只动 allowlist

只迁 `engine/`、`usr/`、`termux/usr` → `runtime/legacy-bionic/`（改名不删）；
`termux/home`、`home/`、`workspace/`、`logs/` 原地不动。判据：迁移后会话/凭据哈希不变。

### 4.3 删树不能穿符号链接

`deleteRecursively()` 会跟着链接走。修法：`Files.walkFileTree`（默认 NOFOLLOW），
并在 rootfs 替换前后做 rename 事务 + 失败回滚。

### 4.4 `run-as` 会丢掉 stdin 的文件重定向

实测：`run-as … < file` 得到 **0 字节**，但 `cat file | run-as …` 正常。
设备侧脚本一律用管道喂 stdin。

### 4.5 带空格的 CWD 会让 sdcard 脚本里的 `run-as` 找不到

在 `/storage/emulated/0/MT2/apks/deepseek harness` 下跑 `/sdcard/.../run.sh` 报
`run-as: not found`；`cd /data/local/tmp` 后正常。设备脚本一律先 `cd`。

### 4.6 guest 看不到 `/sdcard`（除非绑定）

`ProotHost` 只绑 `$DSH_HOME`、workspace、`/sdcard`（有读权限时）、`logs`、`devenv`。
把测试脚本放到 `/sdcard` 再从 guest 里 `node /sdcard/...` 会 `MODULE_NOT_FOUND`。

### 4.7 token 在日志里被脱敏

`engine.log` 里是 `token=***REDACTED***`；任何「靠日志取 token 探活」的脚本都要改成
「端口 + 未授权应得 401」。

---

## 五、构建与发布

### 5.1 artifact 的 `size_in_bytes` 是 zip 大小，不是 APK 大小

按它给 `pm install -S` 会 `INSTALL_PARSE_FAILED_NOT_APK`。用 `stat -c %s` 取真实大小。

### 5.2 版本号三处必须同源

`tools/app-version.txt` 是唯一真相源，CI 会覆盖 `app/build.gradle.kts`；本地也要同步改，
否则看源码的人和 CI 出的包不是同一版。升 vc 必须递增（50 → 51），不能重置。

### 5.3 Release 只在 main 上发

`apk.yml` 有 `event != pull_request && ref == refs/heads/main` 门禁；PR 构建曾经把
`v0.4.4-test` 的资产覆盖掉。分支上只出 artifact，不碰 Release。

### 5.4 镜像里的「平台裁剪」是最容易静默出错的一步

凡是「只保留平台专属包」的循环，都要反问「有没有纯 JS 但按平台名命名的包」
（`@img/colour` 就是这么被删的），并给出包断言。

---

## 六、界面（mobile-ui 插件）

### 6.1 左侧栏图标方向反了

`IconPanelLeftOutlineRegular` 本身竖线在左；官方右侧用法靠 CSS `scaleX(-1)` 翻转。
我们又克隆右侧 SVG 再加 `scaleX(-1)` ⇒ 画成右线。修法：直接用官方图元，不加翻转。

### 6.2 左按钮颜色偏粗、比右按钮高

官方 `ExpandButton` 是 `28×28 / color:var(--dsw-alias-label-secondary) / stroke-width:1 /
top:+11px`，我们原来是 `36×36 / inherit / 1.2 / +8px`。修法：逐项对齐，并按右侧按钮
`getBoundingClientRect()` 动态垂直居中。

### 6.3 关闭侧栏时「工作区条」脱轨飞回

侧栏关闭态只挪 `left`，内部 `sticky/fixed` 子元素在移出屏幕时重排 ⇒ 逐帧飞。
修法：关闭态 `visibility:hidden + pointer-events:none + contain:strict + transition:none`，
`mpSyncDrawer()` 用 `dataset.mpGeomReady` 保证首屏也跑一次几何计算。

### 6.4 像素级验收是唯一可信的判据

`count=688=688 / h=43px=43px / peak_rgb 相同`、关闭瞬态与首页**像素差 0**。
「看起来一样」不算过。

---

## 七、CI / 工具链

- `find \( … \)` 在 GitHub 的 shell 上会报 `invalid expression`；改成多条 `rm -f` 通配。
- 构建步骤**不是 root**（`id -u != 0`），需要 `sudo`；没有 sudo 又没有 root 时应当 **die**
  而不是静默跳过（静默跳过会让断言在出包末尾才炸，看起来像断言写错了）。
- `umount -l` 之后 `mountpoint -q` 仍为真 ⇒ 打包必炸（见 1.5 #4）。
- 下载 artifact 走 API 会 302 到 S3，必须手动跟随 `Location`（`urllib` 默认不跟）。

---

## 八、验收清单（下次直接照这个跑）

```
# 引擎活着 + 数据在
grep -E 'engine.ready ms' files/logs/app.log | tail -1     # health=401
cat files/runtime/rootfs/etc/resolv.conf                   # 公共 DNS，无 127.0.0.53
cd /data/local/tmp && sh /sdcard/Download/s6/run.sh status # tier/health/pidFiles
sh /sdcard/Download/s6/run.sh sharp                        # ok:true
sh /sdcard/Download/s6/run.sh snapshot                     # 与 userdata-before.json 对比
ps -A -o ARGS | grep -c AGNES_CREDENTIAL                   # 只应命中 grep 自己
```

网络三项：`deepseek:401`、`npmmirror:200`、市场出现带「作者/更新于/MIT」的实时条目。
救援三项：`bridge:switch-rescue` → `profile=rescue`、`bridge:try-boot`（活引擎仍在）、
`bridge:switch-back` → `profile=web`。