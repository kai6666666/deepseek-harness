# 给上游的 PR 骨架：`@deepseek-ai/node-addon-system-android-arm64`

目标：让 DSHAPP **不再需要 `FLOCK_PLATFORM_GUARD` 文本补丁**，`flock` 成为上游第一等平台。

## 为什么可行

1. **bionic 有 `flock(2)`** —— `sys/file.h` 里就有，Android 从 API 21 起支持。
2. **N-API 8 跨 Node 版本稳定** —— 编一次，Node 20/22/24/26 通用，不需要每个 Node 版本重编。
3. **loader 已经按 `${platform}-${arch}` 拼包名** —— `native/system/packages/entry/src/flock.ts`：

```ts
const manifest = require.resolve(
  `@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
```

4. **`os` 字段会自动过滤安装** —— 设备上跑 `pnpm install` 时 `process.platform === 'android'`，只有
   `os: ["android"]` 的包会被选中，桌面安装不受影响。

## 需要改三处

### ① 新增平台包（本目录两个文件）

```text
native/system/packages/android-arm64/
├── package.json     # os: ["android"], cpu: ["arm64"]
├── prebuilds.json   # platform: "android-arm64", flock / node-api / napi 8 / libc bionic
├── README.md
└── bin/bionic/system.node    # NDK 编出来的产物（不入库，走 prebuild 流水线）
```

### ② `entry/package.json` 加 optionalDependency

```diff
 "optionalDependencies": {
+  "@deepseek-ai/node-addon-system-android-arm64": "workspace:~",
   "@deepseek-ai/node-addon-system-darwin-arm64": "workspace:~",
```

### ③ `entry/src/flock.ts` 两处

```diff
- if (platform !== 'linux' && platform !== 'darwin') {
+ if (platform !== 'linux' && platform !== 'darwin' && platform !== 'android') {
     throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
       code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM', syscall: 'flock',
     })
   }
   let filename = 'system.node'
-  if (platform === 'linux') {
+  if (platform === 'android') {
+    // bionic 不分 glibc/musl
+    filename = join('bionic', filename)
+  } else if (platform === 'linux') {
     const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
     filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
   }
```

### ④ Landlock 不动

`index.ts` 的 `launcherPath()` 会拼出 `@deepseek-ai/node-addon-system-android-arm64/bin/landlock-run`，
包不存在 → 路径不存在 → `probe()` 返回 `unusable`。**这是设计好的降级，不需要额外改**，
也**不要**往 android 包里塞 `landlock-run`（Android 内核 5.13 才支持 Landlock，塞了永远 `unusable`）。

## 编译产物

```bash
export NDK=$ANDROID_HOME/ndk/27.0.12077973
export CC_aarch64_linux_android=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang
export AR_aarch64_linux_android=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar

cd native/system/packages/entry
npm_config_platform=android npm_config_arch=arm64 npm_config_libc=bionic \
  npx node-gyp rebuild --arch=arm64 --napi_version=8
cp build/Release/system.node ../android-arm64/bin/bionic/system.node
```

验收：

```bash
file  bin/bionic/system.node                     # ELF 64-bit, ARM aarch64
readelf -d bin/bionic/system.node | grep NEEDED # libc.so / libm.so / libdl.so（不是 libc.so.6）
```

## 合并后的收益

| 项 | 合并前 | 合并后 |
|---|---|---|
| DSHAPP 的 `FLOCK_PLATFORM_GUARD` 补丁 | 必需，锚点一改就静默失效 | **删除** |
| `patches/manifest.json` 里的两条 flock 补丁 | 必需 | 变成 optional |
| 每次 DSH 升级 | 要复查锚点 | 只需 `pnpm add` 新版本 |
| 其他插件对 flock 的依赖 | 在 android 上直接失败 | 开箱可用 |
