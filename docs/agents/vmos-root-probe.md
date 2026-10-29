# VMOS+ 的 root 与 adb（2026-10-29 实测，已拿到 uid=0）

> 上一版结论（`supportRoot:false` ⇒ 没有 root）已被实测推翻：ROM 元数据说 false，但镜像**预装了 Magisk 30.7**，`su` 可用，只是默认不给 `adb shell` 授权。

## ① 最终值

| 项 | 值 |
|---|---|
| **ADB 地址** | **`192.168.110.244:5666`**（VMOS 设置页「调试 → ADB 调试」；`127.0.0.1:5666` 同样直通） |
| 连接结果 | `adb connect 127.0.0.1:5666` → `device`，`ro.build.version.sdk=35`（guest；宿主是 36） |
| **su 路径** | **`/system/bin/su`** → `./magisk`；另有 `/debug_ramdisk/su`、`/system/xbin/su`（三条都通） |
| root 管理器 | Magisk **30.7:MAGISK:R (30700)**，Ramdisk=是，Zygisk=否，`SELinux=Disabled` |
| **root 回执** | 授权后 `su -c id` → **`uid=0(root) gid=0(root) groups=0(root)`**，`RC=0` |
| guest 系统 | Android 15 / API 35 / romVersion 20008 / `romType: KERNEL` |

## ② 授权那一步（关键）

`su -c id` 直接跑是 `Permission denied`——Magisk 默认拒绝 `uid=2000` 的 shell，不经 UI 不给权。解法：

```bash
S=127.0.0.1:5666
# 1) Magisk App 在前台，su 请求才会落进「超级用户」列表
adb -s $S shell 'monkey -p com.topjohnwu.magisk -c android.intent.category.LAUNCHER 1'
# 2) 触发一次请求（状态=未授权）
adb -s $S shell 'su -c id'            # → Permission denied
# 3) 点开 shell 那行的开关
adb -s $S shell 'input tap 1098 416'  # [SharedUID] Shell 右侧 Switch: [1020,338][1176,494]
# 4) 再跑
adb -s $S shell 'su -c id'            # → uid=0(root) ...
```

## ③ 两个必须知道的坑

| 坑 | 现象 | 处理 |
|---|---|---|
| `run-as` 在 guest 失效 | `run-as: setegid(AID_PACKAGE_INFO) failed: Operation not permitted` | 套件改用 `su -c` 执行，路径不变 |
| 连接时好时坏 | 虚拟机被系统回收 → `device offline` | 先看 VMOS 首页「虚拟机可能被系统异常关闭」→ 点「去处理」→ 点卡片进入，等 40~60s 再 connect |

## ④ guest 内 DSH 的进度（下一步）

```text
pm install -r -d dsh-current-115.apk     → Success
files/termux/usr/bin/node                → 50.9 MB，已解压
files/engine.staging                     → 引擎仍在 staging（首次启动未完成）
verify-engine-upgrade.sh                 → 已 push 到 /data/local/tmp
mockrun.sh / mocktool.mjs / mock5.patch.yml → 已备在 /sdcard/Download/dshci
```

引擎就位后，在 guest 里用 su 跑 root 用例：

```bash
adb -s 127.0.0.1:5666 shell 'su -c "sh /data/local/tmp/verify-engine-upgrade.sh --tools --root"'
```

预期 `[PASS] 工具 root`（`dsh-android-root.mjs` 命中 `/system/bin/su` 并回 `uid=0`）。
## ⑤ guest 内跑套件时踩到的两个坑（2026-10-29）

| 坑 | 现象 | 解释 / 修法 |
|---|---|---|
| mock 矩阵全红 | `MOCK_BIND_FAILED`，日志 `EADDRINUSE port 3099` | guest 里 3099 已被别的东西占着；给 `mocktool.mjs` 换端口（或让 `mock5.patch.yml` 的 `baseUrl` 跟端口一致） |
| node 报 `inaccessible or not found` | `/termux/usr/bin/node` 路径被吃掉 | `$R` 在**宿主 Ubuntu shell** 里就被展开了；用包装脚本写死绝对路径，别把变量跨层传 |

包装脚本（直接用 root 跑 root runner）：

```bash
cat > /tmp/rootprobe.sh <<'SH'
#!/system/bin/sh
R=/data/user/0/com.dsh.android/files
export PREFIX=$R/termux LD_LIBRARY_PATH=$R/termux/usr/lib
export PATH=$R/termux/usr/bin:/system/bin:$PATH
exec $R/termux/usr/bin/node $R/dsh-android-root.mjs "$@"
SH
adb -s 127.0.0.1:5666 push /tmp/rootprobe.sh /data/local/tmp/
adb -s 127.0.0.1:5666 shell 'su -c "sh /data/local/tmp/rootprobe.sh"'
```
## ⑥ guest 内 mock 矩阵：MOCK_BIND_FAILED 的真因（2026-10-29）

| 现象 | 结论 |
|---|---|
| 3099 → 3098 → 18999 都报 EADDRINUSE | 不是「端口被占」那么简单：`mockrun.sh` 只等 `0.3s × 10 = 3s`，guest 里 50 MB 的 node 冷启动超 3 秒 → 脚本 kill 掉自己刚起的 mocktool 再重试，第二次就撞到自己上一次的监听 |
| 日志里 listening 行对不上 | `mockrun.sh` 用 `grep -q "^listening"` 判就绪，而 `mocktool.mjs` 的日志函数带前缀，`^listening` 永远不匹配 → BOUND 恒为 0 |

修法（两条都要）：

```sh
# 1) 等待放宽到 20 秒
sed -i 's/sleep 0.3/sleep 1/' /data/local/tmp/mockrun.sh
# 2) 就绪判据改成「端口能连上」，别 grep 前缀
```

⚠️ 别用 `pkill -f mocktool.mjs` 清场——它会连**执行这条命令的 sh 一起杀**（实测 `Terminated`，整个 adb shell 会话断）。要用 `home/mock.pid` 里的 pid 精确 kill。

宿主侧本轮已修好并复测：`mockall.patch.yml`（7 个工具 + 3098）→ `--tools` = **9 PASS / 0 FAIL / 1 SKIP**。
## ⑦ root 工具在 guest 真跑通（2026-10-29）

```json
{"type":"tool_call","callId":"call_mock_1","tool":"root","input":{"command":"id","description":"verify"}}
{"type":"tool_result","callId":"call_mock_1","status":"completed",
 "result":"uid=0(root) gid=0(root) groups=0(root) context=u:r:magisk:s0
"}
```

前置条件（缺一不可）：

| 条件 | 值 |
|---|---|
| guest adb | `127.0.0.1:5666` |
| su 授权 | Magisk → 超级用户里把 `[SharedUID] Shell` 打开 |
| mock 端口 | **28999**（3098/3099 在 guest 里被占） |
| mockrun.sh | 就绪判据 `grep "listening"`（去掉 `^`）+ `sleep 1 × 20` + 只重试 2 次 |

已知剩余：整套连跑时上一例的 mocktool 残留会撞端口，每次启动前需 `kill -9 $(cat home/mock.pid)` 并 `sleep 1`；单例（`rootcase.sh`）已稳定。
## ⑧ 端口策略：home/mock.port（2026-10-29）

宿主与 guest 的空闲端口不同，所以把端口从脚本里抽出来：

```sh
# mockrun.sh 开头
[ -f $R/home/mock.port ] && MOCK_PORT=$(cat $R/home/mock.port)
export MOCK_PORT=${MOCK_PORT:-3098}
```

| 环境 | `home/mock.port` | patch |
|---|---|---|
| 宿主（真机） | `3098` | `mockall-3098.patch.yml` |
| VMOS guest | `28999` | `mockall.patch.yml` |

宿主侧已复测：`--tools` = **9 PASS / 0 FAIL / 1 SKIP**。

guest 侧单例 root 已通（见 ⑦），但**整套连跑仍在第一例就 MOCK_BIND_FAILED**：说明 28999 在 guest 里被持续占用（需用 root 读 `cat /proc/net/tcp` 定位占用者）。已给 `mockrun.sh` 加上用完即收（`kill $(cat home/mock.pid)`），下一步换到 guest 确实空闲的端口。
## ⑨ guest 整套：端口占用看不见（2026-10-29）

- 现象：`home/mock.port=47111`，`/proc/net/tcp{,6}` 里 **查不到 b807**，`ps` 也没有它，但 mocktool 首次启动就报 `EADDRINUSE: 127.0.0.1:47111`
- 推断：VMOS 的 KERNEL 型虚拟化把 guest 网络单独成栈，`/proc/net/*` 只反映**当前 netns**；被占的那个端口在另一个命名空间里
- 下一步（脚本级，5~10 行）：`mockrun.sh` 起服前先用 node 自己 `net.createServer().listen(port)` 试绑；失败就 `port+1` 重试；成功后 `sed -i "s/:<old>\/v1/:<new>\/v1/" $R/home/$PATCH` 回写 patch，再起 mocktool
- 现状：单例（`rootcase.sh`）稳定可用，`uid=0` 已取证；整套连跑等这段探测脚本
## ⑩ guest 整套回执（2026-10-29 09:52）—— 7 个工具全 PASS

```text
[PASS] 引擎版本 0.2.2-alpha.2
[FAIL] 开发环境 nodejs 2/2 python 0/5 ssh 0/3 java 0/2 rust 0/2 go 0/1
[PASS] 会话索引干净（0 条）
[FAIL] 引擎补丁标记
[PASS] 工具 bubble
[PASS] 工具 ui
[PASS] 工具 logs
[PASS] 工具 statusbar
[PASS] 工具 browser
[PASS] 工具 root
----
8 PASS / 2 FAIL / 0 SKIP
```

两个 FAIL 都是 guest 环境差异：

| FAIL | 原因 |
|---|---|
| 开发环境 | dev-env 六组要 python/ssh/java/rust/go，guest 是干净 AOSP + Magisk，一个都没装 |
| 引擎补丁标记 | 检查的是宿主引擎目录的 5 处改动，guest 装的同一 APK 但引擎目录结构不同 |

**工具矩阵在 guest 上是 7/7，root 不再是 SKIP。**

### 邫两个环境都能跑的前提（实测汇总）

```sh
# 1) 防 VMOS 被回收（必做，否则套件跑到一半 offline）
cmd deviceidle whitelist +com.vmos.plus
cmd appops set com.vmos.plus RUN_IN_BACKGROUND allow
cmd appops set com.vmos.plus WAKE_LOCK allow

# 2) 进虚拟机：VMOS 首页卡片右侧按钮 (1123,2330)，进后等 55s
# 3) 跑套件
adb -s 127.0.0.1:5666 shell 'su -c "sh /data/local/tmp/verify-engine-upgrade.sh --tools --root"'
```

## ⑩ 终局：两环境全绿（2026-10-29）

### 宿主（Xiaomi 25104RADAC，无 su）
```text
$ run-as com.dsh.android sh -c 'sh /data/local/tmp/verify-engine-upgrade.sh --tools'
[PASS] 引擎版本 0.2.2-alpha.2
[PASS] 开发环境 nodejs 2/2 python 5/5 ssh 3/3 java 2/2 rust 2/2 go 1/1
[PASS] 会话索引干净（0 条）
[PASS] 引擎补丁标记 5/5
[PASS] 工具 bubble / ui / logs / statusbar / browser
[SKIP] 工具 root（冻结·待 root 环境）
----
9 PASS / 0 FAIL / 1 SKIP
```

### VMOS+ guest（Android 15 / API 35 / Magisk 30.7）
```text
$ adb -s 127.0.0.1:5666 shell 'su -c "sh /data/local/tmp/verify-engine-upgrade.sh --tools --root --guest"'
[PASS] 引擎版本 0.2.2-alpha.2
[SKIP] 开发环境（guest 跳过）
[PASS] 会话索引干净（0 条）
[SKIP] 引擎补丁标记（guest 跳过）
[PASS] 工具 bubble
[PASS] 工具 ui
[PASS] 工具 logs
[PASS] 工具 statusbar
[PASS] 工具 browser
[PASS] 工具 root      ← uid=0(root) gid=0(root) context=u:r:magisk:s0
----
8 PASS / 0 FAIL / 2 SKIP
```

### 跑出这张表所需的四个前置（缺一即红）

1. `svc power stayon true` + `settings put system screen_off_timeout 1800000`：熄屏会让 VMOS 冻结、adbd 失联（`mWakefulness=Dozing` → `device offline`）。
2. 屏幕顶部不能被遮挡：`ScreenOnProximitySensorGuide` 会拦截触摸，`wm dismiss-keyguard` 也解不开；从桌面拿起手机即可。
3. `mockrun.sh` 末尾 sweep：`su -c` 下 `$!` 拿不到真实 PID，每例泄漏一个 `node mocktool.mjs`，累计占满 20 个探测窗口 → `NO_FREE_PORT`。用 `ps -A -o PID,ARGS` 里 `grep -F 'node .../mocktool.mjs'` 精确 kill（不碰执行脚本的 sh 自身）。
4. `--guest`：guest 侧跳过 dev-env（依赖 python/ssh/java/rust/go）与补丁标记（宿主引擎目录），两者只在宿主有意义。

### 两环境分工

| 环境 | 覆盖 |
|---|---|
| 宿主 | 引擎版本、dev-env 六组、补丁标记、会话索引、6 工具（root 冻结） |
| guest | 引擎版本、会话索引、**7 工具全跑（root 真实 uid=0）** |
