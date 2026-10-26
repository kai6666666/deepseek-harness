# ⑰ node-addon-require-builtin：源码已镜像，可自建

## 0. 现状（更新）

上游源码已镜像进仓库：`native/require-builtin-src.zip`（52 文件 / 62 KB，取自
jsDelivr 的 `deepseek-ai/dsh-node-addon-require-builtin@HEAD`，因本机 github.com:443 不通）。

CI 里 `require-builtin（源码模式）` 实测：

```text
源文件 30 个（binding.gyp 的 sources，排除 nodeabi 支）
产物   node-addon-android-arm64.zip 374 KB
NEEDED libm.so libdl.so libc.so
```

所以「缺源码」这一条已经不成立；仍待真机确认的是**运行期**：源码的 platform.cc 按
`#if defined(__linux__) && defined(__aarch64__)` 走 **Linux/glibc** 探针，bionic 与 glibc 不同源，
探针可能拿不到 getter offset —— 若如此会退化为 `ERR_REQUIRE_BUILTIN_UNAVAILABLE`，不影响主链路。
下面的「为什么当初造不出」保留作为背景。

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，索引见 [docs/agents/README.md](README.md)。

## 1. 它是什么

引擎里有些代码要 `require()` **Node 的内部 builtin**（`process.binding('natives')` 里那批）。
这不是 N-API 能做的事，所以上游写了一个原生插件：

```ts
// node_modules/node-addon-require-builtin/lib/index.js
const { createEntryApi } = require('node-addon-native-custom-loader');
const api = createEntryApi(path.resolve(__dirname, '..'));
exports.requireBuiltin = (id) => api.requireBuiltin(id);
exports.isAllowedInternalId = (id) => api.isAllowedInternalId(id);
exports.getBindingInfo = () => api.getBindingInfo();
```

平台二进制由 `node-addon-require-builtin-<platform>` 提供，加载器会校验导出的三件事：

| 导出 | 类型 | 校验点 |
|---|---|---|
| `requireBuiltin` | function | 必须存在 |
| `isAllowedInternalId` | function | 必须存在 |
| `getNativeBindingInfo` | function | 返回 `{ product, abi }`，`abi` 必须与期望一致 |

## 2. 为什么 CI 造不出

| 事实 | 后果 |
|---|---|
| npm 包**只发 JS**（`lib/index.js`、`index.d.ts`），没有 `src/` | 没有可编译输入 |
| 原生实现只以**各平台预编译 `.node`** 发布：`linux-x64/arm64-gnu`、`darwin-*` | 没有 `android-arm64` 变体 |
| 实现要访问 Node 内部 builtin 表 | 必须链接 Node 内部符号，**不是纯 N-API**；NDK 单编一个 `.node` 拿不到这些符号 |
| 上游源码在 GitHub（本机 443 不可达） | 无法现场取源码 |

所以这一项的结论是「**缺输入**」，而不是「没做」。

## 3. 两种补齐方式（都已留好插槽）

`tools/build-node-addon-require-builtin.sh` 有三档行为：

### 模式 1：镜像源码（推荐）

```bash
# 把上游 src/ 放进仓库
native/require-builtin/src/*.c
native/require-builtin/src/*.h

./tools/build-node-addon-require-builtin.sh     # 自动用 NDK 27 + node 头文件编
```

产出 `node-addon-android-arm64.zip`，条目：

```text
prebuilt/android-arm64-napi-v9.node
prebuilds.json      # backend=napi, abi=napi-v9, path=prebuilt/…
package.json        # os=android, cpu=arm64
```

### 模式 2：提供已编好的产物

```bash
EXTERNAL_ADDON=/path/to/android-arm64-napi-v9.node \
  ./tools/build-node-addon-require-builtin.sh
```

脚本会先校验（ELF 魔数 / `e_machine == 183` AArch64 / `readelf -d` 的 NEEDED），再打包。

### 模式 3：都没有（当前 CI 的状态）

打印一条 `::warning::` 后 `exit 0` —— **不让出包流水线变红**，资产覆盖停在 27/28。

## 4. 缺了它有什么影响

`EngineManager.ensureNativeAddon()` 只在 `node_modules/node-addon-require-builtin-android-arm64/prebuilt/android-arm64-napi-v9.node`
存在时才装；缺它时引擎照常启动，只是所有走 `requireBuiltin()` 的代码路径会报
`ERR_REQUIRE_BUILTIN_UNAVAILABLE`（受影响的通常是内部工具/诊断类路径，不影响主对话链路）。

## 5. 验收

```bash
unzip -l node-addon-android-arm64.zip        # 3 个条目
unzip -p node-addon-android-arm64.zip prebuilds.json | python3 -m json.tool
python3 - <<'PY'                              # ELF/AArch64 复核
import zipfile, struct
d = zipfile.ZipFile('node-addon-android-arm64.zip').read('prebuilt/android-arm64-napi-v9.node')
assert d[:4] == b'\x7fELF' and struct.unpack('<H', d[18:20])[0] == 183
print('OK')
PY
```