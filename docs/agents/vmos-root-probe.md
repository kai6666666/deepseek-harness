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
