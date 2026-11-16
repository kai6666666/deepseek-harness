# 换设备继续开发（交接手册）

> 更新：2026-11-13 · 当前分支 `feat/proot-0.5.0-x64`（PR #7，tip `9e52b1ba`，CI 全绿）
> 主分支 `main` 仍是 0.4.4-test（`d5a3d6ec`），**没有合并**。所有 0.5.0 新代码都在 PR #7 的分支里。

## 0. 60 秒摘要

```text
0.5.0 = 单运行时 PRoot + Ubuntu rootfs，不再有 bionic / Termux bootstrap。
现在能跑：探针 PASS、真 App 加载官方前端、/sdcard 绑定、/bin/bash、shell 工具挂载。
还没闭环：Shizuku 未授权、shell 实际调用、无线调试配对、dev-env/镜像、S6~S8。
```

## 1. 取代码

```bash
git clone https://github.com/kai6666666/deepseek-harness.git
cd deepseek-harness
git checkout feat/proot-0.5.0-x64      # 或 gh pr checkout 7
git log --oneline -5                    # 应看到 9e52b1ba
```

⚠️ 不要把 clone 直接落在 `/sdcard`：FUSE 上 `git` 的 pack rename 会失败。先落 ext4，或用 codeload tarball。

## 2. 两条出包路径

### A. 直接用 CI（推荐，不需要本地 SDK）

1. GitHub → Actions → `构建 APK（x86_64 runner）` → commit `9e52b1ba` → artifact：
   - `dsh-system-debug`：**arm64 真机包**（141,124,785 B，含 adb-wireless 工具链）
   - `dsh-system-x64-debug`：**x86_64 模拟器包**（不含 adb-wireless，按 ABI 豁免）
2. 下载后：

```bash
adb install -r app-system-debug.apk
```

3. 不同机器的 debug 签名不同：**换机安装前先 uninstall**，否则 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。

### B. 本地出包

需要：

```text
JDK 17
Android SDK: platforms;android-35 / build-tools;35.0.0 / ndk;27.0.12077973
Gradle 8.13（或 wrapper）
```

运行时资产（不在 git 里）：

```text
_build/runtime/out/<abi>/assets/runtime/*  -> app/src/main/assets/runtime/
_build/runtime/out/<abi>/jniLibs/<abi>/*   -> app/src/main/jniLibs/<abi>/
```

无线调试 adb 工具链：

```bash
bash tools/build-adb-wireless.sh
# 产物 app/src/main/assets/adb-wireless-arm64.zip
```

本地构建：

```bash
export JAVA_HOME=<JDK17>
export ANDROID_HOME=<SDK>
gradle -I tools/local/gradle-mirrors.gradle :app:assembleSystemDebug \
  -PtargetAbi=x86_64 --console=plain
# 产物 app/build/outputs/apk/system/debug/app-system-debug.apk
```

`-PtargetAbi` 默认 `arm64-v8a`。

## 3. 模拟器（x86_64）

Windows（本机实测可行）：

```text
JDK17 + cmdline-tools
sdkmanager "platform-tools" "emulator" "platforms;android-34" \
  "system-images;android-34;google_apis;x86_64" \
  "extras;google;Android_Emulator_Hypervisor_Driver"
extras/google/Android_Emulator_Hypervisor_Driver/silent_install.bat
sc query aehd            # RUNNING
emulator -accel-check    # AEHD ... usable
avdmanager create avd -n dsh34 -k "system-images;android-34;google_apis;x86_64" -d medium_phone
emulator -avd dsh34 -port 5556 -no-window -no-audio -no-snapshot -gpu swiftshader_indirect
```

Linux 需要 `/dev/kvm`。

```text
❌ 雷电/MuMu 不行：镜像拒绝 ptrace(TRACEME)，PRoot 起不来
✅ Google APIs AVD 可以（已实测）
```

## 4. 装完先验什么

### 4.1 探针

```bash
adb shell am force-stop com.dsh.android
adb shell run-as com.dsh.android mkdir -p files
adb shell run-as com.dsh.android touch files/proot-probe.enable
# 必须 NEW_TASK|CLEAR_TASK：否则旧 MainActivity task 会被恢复，引擎会把探针顶掉
adb shell am start -W -f 0x10008000 -n com.dsh.android/.runtime.ProotProbeActivity
adb shell run-as com.dsh.android cat files/proot-probe.txt
```

期望：

```text
health=PASS
stopped=true
leftover_node=0
RESULT=PASS
```

### 4.2 真 App

```bash
adb shell am start -n com.dsh.android/.MainActivity
adb exec-out screencap -p > screen.png
```

应看到官方前端「探索未至之境 / 默认工作区」。

### 4.3 权限

`pm clear` 会重置运行时权限：

```bash
adb shell pm grant com.dsh.android android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.dsh.android android.permission.WRITE_EXTERNAL_STORAGE
```

未授权时 `/sdcard` 不会绑，launch 行里也没有 `-b /storage/emulated/0:/sdcard`，这是设计行为。

## 5. S5 当前状态（2026-11-13）

| 项 | 状态 | 证据 |
|---|---|---|
| `/sdcard` 绑定 | ✅ launch 行含 `-b /storage/emulated/0:/sdcard` | [s5-sdcard-bind](evidence/s5-sdcard-bind.md) |
| `bash` 身份 | ✅ rootfs `/bin/bash` + `SHELL=/bin/bash` + proot `-0` | 同上 |
| `shell`(uid2000) 工具 | 🟡 runner/插件/overlay/env/bind 已就位；Shizuku `granted=false`，待实际调用 | [s5-shell-root-wiring](evidence/s5-shell-root-wiring.md) |
| `root`(uid0) | ✅ 无 su 时正确不挂载 | 同上 |
| 无线调试 adb 资产 | ✅ CI 现场生成 `adb-wireless-arm64.zip` | [s5-adbwire](evidence/s5-adbwire.md) |
| dev-env / 镜像 | ⬜ | — |
| S6 数据迁移 / S7 矩阵 / S8 发布 | ⬜ | — |

## 6. 不能踩的坑

1. **不要用 patchelf 改 proot 的 DT_NEEDED**：改过的二进制 SIGSEGV；依赖按原名从 assets 解到 `files/proot-libs`。
2. **pidfile 命令必须是 `echo $$`**，不是 `echo $`。
3. **裁剪 node_modules 不能删 JS 平台包**（如 `@deepseek-ai/dsh-win32-process`）。
4. **不要提交 `app/src/main/assets/runtime/*`、`jniLibs/*`、`app/build/*`**。
5. **单文件 >5 MB 不入库**：仓库卫生门禁会直接失败。adb 工具链走 `tools/build-adb-wireless.sh` 现场生成。
6. **targetSdk 保持 28**：29+ 禁止 execve 私有目录，proot 全挂。
7. **探针必须 `NEW_TASK|CLEAR_TASK`**：`-f 0x10008000`；否则旧 MainActivity 恢复后会把探针进程顶掉，表现为 `TOKEN_TIMEOUT`。
8. **`run-as` 不能当 `/sdcard` 访问的判据**：`runas_app` SELinux 域会被 FUSE 拒绝，App 进程本身不受这个限制。
9. **MIUI 安装验证**：`pm install` 可能返回 `INSTALL_FAILED_USER_RESTRICTED`；用包安装器显式组件可拉起，最后需要机主指纹/密码：

```bash
adb shell am start -n com.miui.packageinstaller/com.miui.packageInstaller.InstallStart \
  -d file:///sdcard/Download/app-system-debug.apk \
  -t application/vnd.android.package-archive
```

10. **debug 签名每版不同**：每次换包都要卸载，会丢 app 内数据；固定 keystore 还没做。
11. **x86_64 包不含 adb-wireless**：`check-apk-assets.py` 只对 `arm64-v8a` 做硬断言。
12. **换 debug 签名先卸载**：`adb uninstall com.dsh.android`。

## 7. 下一步

```text
1. 装 9e52b1ba 的 arm64 APK（artifact 14028368148，141,124,785 B）
2. 在 App 设置里给 Shizuku 授权
3. 让模型调一次 shell，确认 privileged=true 或诚实回落
4. 固定 CI 签名：debug keystore + signingConfig
5. S5 剩余：dev-env、镜像、无线调试配对
6. S6 数据迁移 / S7 真机矩阵 / S8 发布 0.5.0（vc51）
```

## 8. 证据与延伸

- [S5 证据目录](evidence/README.md)
- [0.5.0 执行计划](proot-0.5.0-execution.md)
- [CHANGELOG](../../CHANGELOG.md)