# 安装 / 验收 / 回滚：0.2.2-rc.3-debug（一页版）

> 本文是 [docs/agents/README.md](README.md) 的分册。
> 适用构建：`v0.2.2-rc.3-debug`（versionCode **53**，system debug flavor）。
> 计划与证据：[engine-0.2.2-rc.3-plan.md](engine-0.2.2-rc.3-plan.md) §13。

## 1. 这一版是什么

| 项 | 值 |
|---|---|
| 引擎 | `@deepseek-ai/dsh@0.2.2-rc.3`（PRoot 单运行时，rootfs 171 MB） |
| versionName / versionCode | `0.2.2-rc.3-debug` / `53`（覆盖 vc52 不卸载） |
| mobile-ui | `1.1.0-186` |
| 签名 | `tools/dsh-debug.keystore`（与 vc52 同源） |
| Release | `v0.2.2-rc.3-debug`（prerelease） |
| 资产名 | `dsh-android-0.2.2-rc.3-debug-arm64.apk` |
| sha256（Release 资产） | `56b784dc5e23d111bbc488b5d87ad03a827a478ab232358b26fc00f23fabf8c8` |
| 签名证书 SHA-256 | `79d0dab6822c276f054bb9d53a24dd65fc54b3a185c902a3372b1090a448dc96`（与 vc52 同源，可直接覆盖安装） |
| APK 体积 | 194,499,497 B（185.4 MiB） |

下载：`https://github.com/kai6666666/deepseek-harness/releases/tag/v0.2.2-rc.3-debug`

## 2. 安装

```bash
# 有 adb
adb install -r -t dsh-android-0.2.2-rc.3-debug-arm64.apk
# 无 adb：手机上下载后点开安装；或本机副本
#   /storage/emulated/0/Download/dsh-rc3/dsh-android-0.2.2-rc.3-debug-arm64.apk
```

`-r` 保留数据；`-t` 允许 test-only 包。**不要先卸载**——卸载会清 `$DSH_HOME`（会话/凭据/插件）。

## 3. 首启（必须等，别急着判失败）

首启要把 171 MB 归档解到 `files/runtime/rootfs`，手机上约 3–8 分钟。

```bash
SER=$(adb devices | awk 'NR==2{print $1}')
adb -s "$SER" logcat -c
adb -s "$SER" shell am start -n com.dsh.android/.MainActivity
for i in $(seq 1 120); do
  S=$(adb -s "$SER" shell "run-as com.dsh.android cat files/runtime/.rootfs.stamp" 2>/dev/null | tr -d '\r')
  [ -n "$S" ] && { echo "stamp=$S"; break; }
  sleep 5
done
adb -s "$SER" logcat -d -s DSH:I | grep -E 'rootfs 就绪|引擎就绪|assetStamp|解包'
```

**绿灯判据**：`stamp` 含 `dsh0.2.2-rc.3`；日志有 `rootfs 就绪` 与 `引擎就绪`。

前置条件：`files` 所在分区可用空间 **≥ 3.4 GiB**（升级峰值 = 旧 rootfs + staging + 缓存归档）。空间不足会在日志里报「存储空间不足：需要约 3400 MB」。

## 4. 验收（一条命令）

```bash
cd "/storage/emulated/0/MT2/apks/deepseek harness/deepseek-harness-0.2.2-rc.1"
./tools/verify-rc3-device.sh
# guest（VMOS）：
# ADB="adb -s 127.0.0.1:5666" TIMEOUT=300 ./tools/verify-rc3-device.sh
```

它做四件事：把 `tools/proot-verify-driver.cjs` 推进 `files/home/.dsh/` → `am start` 探针（`--es run_script`）→ 轮询 `files/proot-probe.txt` → 打印 driver 的 stdout。**所有 node 都在 proot 内跑**，不在 `run-as` 里裸跑（rootfs 的 node 是 glibc ELF，裸跑必 ENOENT）。

> ⚠️ driver 必须是 **`.cjs`**：Node 按扩展名定模块系统，`.mjs` 里 `require` 会直接 `ReferenceError`（本轮踩过）。
> 脚本要放在 guest 可见路径（`$DSH_HOME` / `workspace` / `/sdcard`），`/data/local/tmp` 在 proot 内看不见。

driver 的实际输出（2026-11-18 真机实测，本机）：

```text
platform=linux        arch=arm64
engine=0.2.2-rc.3     img_type=relaxed
files=7/7             office_kit=present
bash=yes              flock=loadable
mode=proot-single-runtime
RESULT=PASS
```

判据按**运行时分线**（这条很关键，别再用 bionic 那五项）：

| 运行时 | 绿线 |
|---|---|
| `platform=linux`（PRoot 单运行时） | `engine=0.2.2-rc.3` + `img_type=relaxed` + `files=7/7` + `flock=loadable` |
| `platform=android`（bionic 旧包） | 上述 + `patch-marks=4/4`（flock / fail-loud-boot / terminal-shell / attachment-fsync） |

> PRoot 的 guest 是 Ubuntu：`process.platform=linux`、`/bin/bash` 存在、`flock` 走 linux 分支，
> 所以 bionic 时代的 flock / terminal-shell 补丁**本来就不适用**，拿它们判失败是判据错。

## 5. 手工复核（不看脚本时）

| 项 | 怎么看 |
|---|---|
| 引擎版本 | `run-as com.dsh.android cat files/runtime/rootfs/opt/dsh/node_modules/@deepseek-ai/dsh/package.json` → `"version": "0.2.2-rc.3"` |
| 发图白名单 | rootfs 内 `dsh-client-ui-conversation/lib/client.js` 含 `return value.startsWith(\`image/\`)` |
| 运行时版本戳 | `files/runtime/.rootfs.stamp` 与 `files/runtime/manifest.json` 的 `runtimeVersion` 一致 |
| 移动端 UI | `files/home/.dsh/mobile-ui/dsh-android-mobile/.mobile_ui_version` = `1.1.0-186` |

## 6. 回滚

| 场景 | 动作 |
|---|---|
| 只想退回 vc52 | `adb install -r -d <vc52 apk>`（同签名可覆盖，数据不动） |
| rootfs 坏了 / 想重解包 | `run-as com.dsh.android rm files/runtime/.rootfs.stamp`，重启 App |
| 会话发不出去 | 先看 `files/logs/engine.log` 有无 `did not activate`；必要时清 `files/home/anchor-miss.json` |
| 彻底重来 | **只在备份后**：`/sdcard/Download/dsh-backup-<ts>.tgz` 里有 `home/.dsh` 与 `workspace` |

## 7. 已知边界

- `run-as sh -c '<rootfs>/usr/bin/node x.mjs'` 永远失败（缺 `/lib/ld-linux-aarch64.so.1`），这是设计，不是缺陷。
- `tools/verify-engine-upgrade.sh` 与 `tools/mockrun.sh` 保留为 bionic 时代历史入口，rc.3 起不要用它们验收。
- APK 里 `flock.js` / `dsh-terminal-bash` 是原样文件，首启后才被改——这是"启动期补丁"与"构建期补丁"的分工。