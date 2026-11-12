# 换设备继续开发（交接手册）

> 更新：2026-11-13 · 当前分支 `feat/proot-0.5.0-x64`（PR #7，tip `9479b961`，CI 全绿）
> 主分支 `main` 仍是 0.4.4-test，**没有合并**。所有新代码都在 PR #7 的分支里。

## 0. 先做的事

1. **轮换 GitHub token**：不要再把 PAT 贴进对话或写进任何文件；用 `gh auth login` 或系统凭据管理器。
2. 确认仓库是 `kai6666666/deepseek-harness`，PR #7 可见。
3. 新设备上不需要旧的 AVD 数据（rootfs 会在首启重新解包，约 35 s）。

## 1. 取代码

```bash
git clone https://github.com/kai6666666/deepseek-harness.git
cd deepseek-harness
git checkout feat/proot-0.5.0-x64      # 或 gh pr checkout 7
git log --oneline -5                    # 应看到 9479b961
```

## 2. 两条出包路径

### A. 直接用 CI（推荐，不需要本地 SDK）

1. GitHub → Actions → 最近一次 `构建 APK（x86_64 runner）`（commit `9479b961`）→ artifact：
   - `dsh-system-debug`：**arm64 真机包**
   - `dsh-system-x64-debug`：**x86_64 模拟器包**（`构建 APK（x86_64 模拟器）` 的 artifact）
2. 下载后 `adb install -r app-system-debug.apk`。
3. 注意：不同机器的 debug 签名不同，**换机安装前先 uninstall**，否则 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。

### B. 本地出包

需要：
- JDK 17；
- Android SDK：`platforms;android-35`、`build-tools;35.0.0`、`ndk;27.0.12077973`；
- Gradle 8.13（或 wrapper，但 wrapper 要从 services.gradle.org 下发行包）；
- **运行时资产**（不在 git 里，见下）。

取运行时资产，二选一：

1. 下载 CI artifact `runtime-arm64-v8a` / `runtime-x86_64`，铺到：
   ```text
   _build/runtime/out/<abi>/assets/runtime/*  ->  app/src/main/assets/runtime/
   _build/runtime/out/<abi>/jniLibs/<abi>/*.so ->  app/src/main/jniLibs/<abi>/
   ```
2. 或在 **Linux x86_64** 上自己构建：
   ```bash
   ABI=arm64-v8a CC=aarch64-linux-gnu-gcc bash tools/runtime/build-runtime.sh
   ABI=x86_64    CC=gcc                     bash tools/runtime/build-runtime.sh
   ```
   （需要 `patchelf xz-utils python3 dpkg`；组装必须在 ext4 上）

本地构建（镜像可选）：

```bash
export JAVA_HOME=<JDK17>
export ANDROID_HOME=<SDK>
gradle -I tools/local/gradle-mirrors.gradle :app:assembleSystemDebug \
  -PtargetAbi=x86_64 --console=plain
# 产物 app/build/outputs/apk/system/debug/app-system-debug.apk
```

`-PtargetAbi` 默认 `arm64-v8a`；模拟器用 `x86_64`。

## 3. 模拟器（x86_64）

Windows（本机实测可行）：

1. 装 JDK17 + cmdline-tools；
2. `sdkmanager "platform-tools" "emulator" "platforms;android-34" "system-images;android-34;google_apis;x86_64" "extras;google;Android_Emulator_Hypervisor_Driver"`；
3. 跑 `extras/google/Android_Emulator_Hypervisor_Driver/silent_install.bat`（管理员），确认 `sc query aehd` = RUNNING；
4. `emulator -accel-check` 应返回 `AEHD ... usable`；
5. `avdmanager create avd -n dsh34 -k "system-images;android-34;google_apis;x86_64" -d medium_phone`；
6. `emulator -avd dsh34 -port 5556 -no-window -no-audio -no-snapshot -gpu swiftshader_indirect`。

Linux：需要 `/dev/kvm`；命令同上（不需要 AEHD）。

> ❌ 雷电/MuMu 这类游戏模拟器不行：它们的 Android 镜像拒绝 `ptrace(TRACEME)`，PRoot 起不来。
> ✅ Google APIs AVD 可以（已实测）。

## 4. 装完先验什么

```bash
adb install -r app-system-debug.apk
adb shell run-as com.dsh.android mkdir -p files
adb shell run-as com.dsh.android touch files/proot-probe.enable
adb shell am start -n com.dsh.android/.runtime.ProotProbeActivity
adb shell run-as com.dsh.android cat files/proot-probe.txt
# 期望：health=PASS / stopped=true / leftover_node=0 / RESULT=PASS
```

再验真 App：

```bash
adb shell am start -n com.dsh.android/.MainActivity
adb exec-out screencap -p > screen.png
```

应看到官方前端（“Into the Unknown”）。目前首页会停在 “Choose workspace”，这是下一步 S5 的第一个任务。

## 5. 当前状态与下一步

- 已完成：S1 运行时 CI、S2 安装器、S3 ProotHost/APK 内置运行时、S4a 启动切换、S4b bionic 资产下线、S4c bionic 代码删除、S4.5 x86_64 + AVD 验证。
- 下一步：S5（默认工作区、bash/沙箱、shell/root 通道、无线调试、dev-env/镜像），随后 S6/S7/S8。
- 详细计划与实测记录：[`docs/plan/proot-0.5.0-execution.md`](../plan/proot-0.5.0-execution.md)（§9 是 AVD 踩坑与 PASS 证据）。

## 6. 不要踩的坑（血泪清单）

1. **不要用 patchelf 改 proot 的 DT_NEEDED**——改过的二进制 SIGSEGV；依赖按原名从 assets 解到 `files/proot-libs`。
2. **pidfile 命令必须是 `echo $$`**，不是 `echo $`；否则停止时杀不到 node。
3. **裁剪 node_modules 不能删 JS 平台包**（如 `@deepseek-ai/dsh-win32-process`），否则 subprocess/sandbox 服务 import 失败；只删 `@img/sharp-*`、`node-addon-system-*` 与其它 `prebuilds/*`。
4. **不要提交 `app/src/main/assets/runtime/*`、`jniLibs/*`、`app/build/*`**：全部由 CI 或本地脚本生成。
5. **targetSdk 保持 28**；升到 29+ 会禁止 execve 私有目录，proot 全挂。
6. **模拟器安装换 debug 签名要先卸载**，否则安装失败（会丢 app 内数据，这是预期）。
7. **旧后台的 AVD 别一直开着**：`adb -s emulator-5556 emu kill`。
