# S5 shell(uid2000)/root(uid0) 接线（2026-11-13）

## 提交
- `ab2d4ffd` feat(runtime): 重新接线 shell(uid2000)/root(uid0) 通道（S5）

## 改动
### EngineManager.startProot()
恢复 S4c 删掉的 orchestration：
```text
ensurePrivilegedShell()
ShizukuChannel.start(context)
ensureAdbWireless()
ensurePrivilegedPlugin()
writePrivilegedPatch(privRunner != null)
ensurePrivilegedPrompt(...)

ensureRootShell()
RootAccess.detect(context)
ensureRootPlugin()
writeRootPatch(...)
ensureRootPrompt(...)
```
overlays 追加 `privPatch` / `rootPatch`。

### env
```text
DSH_PRIV_RUNNER
DSH_ROOT_RUNNER
DSH_ADB_HOME
DSH_SHIZUKU_SOCKET
```

### ProotHost bind
```text
files/dsh-android-shell.mjs -> 同路径
files/dsh-android-root.mjs  -> 同路径
files/adbwire             -> 同路径
```

## CI（ab2d4ffd）
```text
assembleSystemDebug success
assembleSystemDebug (x86_64) success
:app:compileSystemDebugKotlin success
build-runtime (arm64-v8a) success
build-runtime (x86_64) success
engine 包独立编译 success
敏感文件与密钥扫描 success
文档结构与链接 success
runtime (arm64-v8a) success
```

## APK
```text
artifact 14011302040
size     134,969,475 B
sha256   06cf0ced454dee0a13c8af77e139cbc26d41e1ece437a2c2e3dab62944b41c5b
```

## 真机安装再次被 MIUI 身份验证挡住
`pm install -r`：
```text
Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]
```
包安装器已走到：
```text
请验证身份确认安装
请将手指放置于图案上
```
需要机主指纹，自动化无法代替；当前 `com.dsh.android` 未安装。

## 装完后要验
```bash
# runner / overlay 是否落盘
run-as com.dsh.android ls -l files/dsh-android-shell.mjs
run-as com.dsh.android ls -l files/home/.dsh/shell-tool/dsh-android-shell/lib/index.js
run-as com.dsh.android ls -l files/home/.dsh/shell-tool.patch.yml

# guest 里 runner 与 adbwire 是否可见
logcat -d -s ProotHost | grep 'launch:' | grep -E 'dsh-android-shell.mjs|adbwire'

# 引擎 env 是否注入
logcat -d -s ProotHost | grep -E 'DSH_PRIV_RUNNER|DSH_ADB_HOME|DSH_SHIZUKU_SOCKET'
```

## 真机安装与接线取证（17:55）
```text
versionCode=50 / versionName=0.4.4-test
engine.ready.proot t+123013ms
Web 界面加载完成 t+126s
```

### Shizuku / root
```text
Shizuku 桥已就绪: manager=true binder=true granted=false
root 不可用（ABSENT: 设备上没有 su），root 工具未挂载
```

### 落盘
```text
files/dsh-android-shell.mjs                              113566 B
files/home/.dsh/shell-tool.patch.yml                     388 B
files/home/.dsh/shell-tool/dsh-android-shell/lib/index.js 18375 B
files/home/.dsh/root-tool.patch.yml                      不存在（符合预期）
```

### launch 行
```text
-b .../files/dsh-android-shell.mjs:.../files/dsh-android-shell.mjs
-b .../files/dsh-android-root.mjs:.../files/dsh-android-root.mjs
DSH_PRIV_RUNNER=.../files/dsh-android-shell.mjs
DSH_ROOT_RUNNER=.../files/dsh-android-root.mjs
DSH_SHIZUKU_SOCKET=com.dsh.android.shizuku
--patch .../shell-tool.patch.yml
```
无 `adbwire` 绑定，`DSH_ADB_HOME` 未注入：
```text
files/adbwire 不存在
```
说明无线调试 adb 工具链还没随 0.5.0 分发。

## 结论
- `shell` 工具：runner/插件/overlay/env/绑定五件齐全，Kotlin 侧 `shellToolMounted=true`，等模型实际调用验证 uid 2000/回落。
- `root`：探测正确判定无 su，未挂 overlay，符合“没有 root 是常态”。
- 无线调试：缺 `adbwire`，是 S5 下一项。
