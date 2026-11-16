# S5 /sdcard 绑定与 bash 身份（2026-11-13）

## 提交
- `894ea2e2` feat(runtime): proot 绑定手机存储到 /sdcard（S5）

## 安装
`pm install -r` 成功，版本：
```text
versionCode=50 / versionName=0.4.4-test
```
`pm clear` 后需要重新授予存储权限：
```bash
pm grant com.dsh.android android.permission.READ_EXTERNAL_STORAGE
pm grant com.dsh.android android.permission.WRITE_EXTERNAL_STORAGE
```
未授权时 `defaultPhoneStorage()` 返回 null，launch 行里不会出现 `-b`，这是设计行为。

## 冷装探针
```text
runtimeVersion=r1-arm64-v8a-dsh0.2.2-rc.1-node24.22.1-ubuntu24.04.5-130ef3d3a8cf
started (+7ms)
token_after_ms=28591
http=401
health=PASS
stopped=true
leftover_node=0
RESULT=PASS
```

## launch 行（已确认两条 bind）
```text
... -b /data/user/0/com.dsh.android/files/workspace:/data/user/0/com.dsh.android/files/workspace \
    -b /storage/emulated/0:/sdcard \
    -b /storage/emulated/0:/storage/emulated/0 \
    /usr/bin/env -i HOME=/root ... SHELL=/bin/bash ...
```
logcat 无 `can't sanitize binding` 警告。

## bash 身份
```text
rootfs/bin/bash 存在，1543048 B，可执行
terminal-bash/lib/index.js: DEFAULT_BASH_SHELL = "/bin/bash"
proot 启动带 -0；env SHELL=/bin/bash
```
`patchTerminalShell()` 在 0.5.0 里没有被调用，因此不会把 `/bin/bash` 改写成 Termux 的 `$PREFIX/bin/bash`；guest 内直接用 Ubuntu bash。

## 下一项审计：shell/root 通道在 0.5.0 里没有接线
以下函数存在但 `grep` 无任何调用点：
```text
ensurePrivilegedShell()
ensurePrivilegedPlugin()
ensureRootShell()
ensureRootPlugin()
writePrivilegedPatch()
writeRootPatch()
ensurePrivilegedPrompt()
ensureRootPrompt()
```
S4c 删除 bionic `start()` 时把 orchestration 一起删了，所以：
- `files/dsh-android-shell.mjs` 不会解出
- `$DSH_HOME/shell-tool/...` 不会安装
- `DSH_PRIV_RUNNER` / `DSH_ROOT_RUNNER` 没有注入
- guest 里也没有绑定 runner 文件与 `adbwire`

结论：0.5.0 目前只有 `bash`（app 身份、guest root），没有 `shell`(uid 2000) 与 `root`(uid 0) 工具。
