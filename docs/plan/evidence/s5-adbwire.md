# S5 无线调试 adb 资产回填（2026-11-13）

## 提交链
```text
50773b58  把 5.9 MB zip 直接入库 -> 卫生门禁失败（>5 MB）
77f3548b  改为 tools/build-adb-wireless.sh 现场生成；删除入库 zip
9e52b1ba  adb-wireless 只对 arm64 APK 做硬断言（x86_64 模拟器包不要求）
```

## 生成脚本
`tools/build-adb-wireless.sh`：
```text
从 Termux 镜像取 android-tools + 9 个依赖 deb
ar p data.tar.xz | tar -xJ
只保留 bin/adb + KEEP 前缀库
zip: bin/adb (0755) + lib/*.so
```
本机实跑：
```text
条目 109 个
✅ bin/adb + 108 个库
5.9 MB
```

## CI（9e52b1ba，全绿）
```text
assembleSystemDebug success
assembleSystemDebug (x86_64) success
:app:compileSystemDebugKotlin success
build-runtime (arm64-v8a) success
build-runtime (x86_64) success
敏感文件与密钥扫描 success
engine 包独立编译 success
文档结构与链接 success
runtime (arm64-v8a) success
```
APK artifact `14028368148`，141,124,785 B。

## 已安装版本的手工等价验证
当前设备装的是 `ab2d4ffd`（代码已含 adbwire env/bind），把工具链预铺到 `files/adbwire` 后重启：
```text
-b /data/user/0/com.dsh.android/files/adbwire:/data/user/0/com.dsh.android/files/adbwire
DSH_ADB_HOME=/data/user/0/com.dsh.android/files/adbwire
engine.ready.proot t+34040ms
```
说明 `ensureAdbWireless()` 的完整性哨兵、env 注入、guest bind 三条链路都通。

## 仍待
- Shizuku `granted=false`：shell 工具会注册，但实际调用可能回落 app 身份。
- 新 APK 141 MB 尚未覆盖安装（当前代码等价，手工预铺已验证）。
