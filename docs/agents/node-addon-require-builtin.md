# ⑰ node-addon-require-builtin：源码已镜像，CI 能真编了

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，索引见 [docs/agents/README.md](README.md)。

## 1. 它解决的问题

引擎里有一部分代码要 `require()` **Node 的内部 builtin**（`process.binding('natives')` 那批）。
这不是 N-API 能做的事，所以上游写了一个原生插件，接口由 `node-addon-native-custom-loader` 校验：

| 导出 | 用途 |
|---|---|
| `requireBuiltin(id)` | 拿到内部模块 |
| `isAllowedInternalId(id)` | 白名单判定 |
| `getNativeBindingInfo()` | 返回 `{ product, abi }`，加载器用它做一致性校验 |

## 2. 源码从哪来

上游：`github.com/deepseek-ai/dsh-node-addon-require-builtin`（默认分支 **master**）。

本机 `github.com:443` 不通，走 **GitHub API + jsDelivr** 取到（`api.github.com` 可用）：

- tree：`GET /repos/{owner}/{repo}/git/trees/master?recursive=1`
- 文件：`GET /repos/{owner}/{repo}/git/blobs/{sha}`（base64）

挑了 52 个文件（`packages/native/**` + `packages/require-builtin/entry/**` + LICENSE/README），
165,378 B，打成 `native/require-builtin-src.zip`（61,753 B）随仓库分发。

> 本地解包副本在 `native/require-builtin-src/`（不入库，只留 zip）。

## 3. 编译配方（照 `binding.gyp` 的 napi 后端）

`tools/build-node-addon-require-builtin.sh` 会从 zip 解包，按 gyp 里的 `.cc` 列表编译：

```text
源文件     30 个（排除 runtime_compat_nodeabi.cc，走 napi 分支）
定义       NAPI_VERSION=9 · NAPI_DISABLE_CPP_EXCEPTIONS · NODE_ADDON_API_DISABLE_CPP_EXCEPTIONS
           NARB_BACKEND=1 · NARB_PRODUCT=1（= require-builtin 变体，见 product_config.h）
编译       aarch64-linux-android26-clang++ -c -fPIC -O2 -std=c++17 -fno-exceptions -fvisibility=hidden
链接       -shared -static-libstdc++ -Wl,--build-id=none
```

⚠️ 两个容易踩的坑：

1. **必须同时给 `NAPI_DISABLE_CPP_EXCEPTIONS`**。只给 gyp 里的 `NODE_ADDON_API_DISABLE_CPP_EXCEPTIONS` 时，
   node-addon-api 会报 `Exception support not detected`，后面全是 `no matching function for call to 'New'` 的级联错误。
2. **链接要 `-static-libstdc++`**，否则拉 `libc++_shared.so`，Termux 里没有。

## 4. 实测（run 40354163802）

```text
源文件 30 个
NEEDED libm.so libdl.so libc.so        ← 无 libc++_shared
zip    node-addon-android-arm64.zip  374 KB
条目   prebuilt/android-arm64-napi-v9.node + prebuilds.json + package.json
APK    173,420,051 B（~165.4 MiB）
```

至此 **28/28 全部资产都能在 CI 从零产出**（无需任何预先上传的 Release）。

## 5. ⚠️ 运行时仍需真机验证

`runtime_probe/platform.cc` 的平台判定用的是 `__linux__`，**Android 也会命中它**，
于是走的是 `linux_arm64` 的 V8 getter 解析器（`getter_decoder` 按机器码模式找
`require` getter 偏移）。能不能在 bionic + Termux node 26 上真的解出偏移，**编译成功不等于跑通**。

判定方式（真机）：

```bash
# 在 $DSH_HOME/node_modules 下
node -e "const a=require('node-addon-require-builtin'); console.log(a.getBindingInfo())"
# 期望：{ product: 'require-builtin', abi: 'napi-v9', ... }
# 若报 kUnsupportedNoGetter / 偏移解析失败 → 需在 runtime_probe 里补 android 分支
```

失败时的影响是局部的：加载器会校验失败并抛错，主对话链路不受影响（见 [ci-build.md](ci-build.md) §9）。

## 6. 上游更新时怎么重做

```bash
# 1) 重新拉源码（api.github.com 可用时）
#    tree → blobs → 写入 native/require-builtin-src/ → 打 native/require-builtin-src.zip
# 2) 重跑
./tools/build-node-addon-require-builtin.sh
```

版本一变，`entry/package.json` 的 `version` 与预编译包名也会变，记得同步 `prebuilds.json` 里的 `abi`。