# DSH 插件开发与上架指南

> 面向第三方开发者的完整教程：从零写一个插件，发布到 npm，让它出现在 App 的**插件市场**里。
>
> 本文所有字段定义来自引擎自带的权威类型声明
> `@deepseek-ai/dsh-package-manifest`（`lib/types/types.d.ts`），
> 所有命令都在本机实跑过，标注「实测」的都有输出证据。

---

## 目录

- [1. 五分钟上手](#1-五分钟上手)
- [2. 插件包的结构](#2-插件包的结构)
- [3. 写 host 半（引擎侧）](#3-写-host-半引擎侧)
- [4. 写 client 半（界面侧）](#4-写-client-半界面侧)
- [5. Android 兼容性约束](#5-android-兼容性约束)
- [6. 发布到 npm](#6-发布到-npm)
- [7. 收录进插件市场](#7-收录进插件市场)
- [8. 排错速查](#8-排错速查)

---

## 1. 五分钟上手

一个 DSH 插件就是一个**普通的 npm 包**，只是 `package.json` 里多了一个 `dsh` 字段。
没有编译步骤、没有构建工具、没有 JSX —— 写纯 ESM / 纯 JS 就能发布。

最小可用插件只要 3 个文件：

```
dsh-hello-dsh/
├── package.json          # 包身份 + dsh 声明
├── cordis.patch.yml      # 告诉引擎「把我挂上去」
└── lib/
    └── index.js          # host 半：引擎里跑的代码
```

想改界面，再加一个 `lib/client.js`（client 半）。

**两条命名红线**：

1. 包名**不要**用 `@deepseek-ai/` 前缀 —— 那是官方作用域，你发布不了，
   市场里也会和官方插件混淆。用自己的作用域（`@你的用户名/xxx`）或裸名。
2. 插件的 `id`（`cordis.patch.yml` 里的 `id` 与 client 半的 `load({id})`）
   必须**全局唯一**。建议直接等于包名，或包名去掉 `@` 和 `/`。

---

## 2. 插件包的结构

### 2.1 目录结构

```
dsh-hello-dsh/
├── package.json
├── cordis.patch.yml
├── README.md            # 可选，但强烈建议
├── LICENSE              # 可选
└── lib/
    ├── index.js         # host 半（必需）
    └── client.js        # client 半（可选，要改界面才需要）
```

`package.json` 的 `files` 字段是**白名单** —— 只列进去的东西才会进 npm 包，
其他一律不带。这一点在打包时会被严格验证（见 §6.3）。

### 2.2 package.json

```json
{
  "name": "dsh-hello-dsh",
  "version": "1.0.0",
  "description": "一句话说清这个插件干什么 —— 市场列表里显示的就是它。",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "keywords": ["dsh", "dsh-plugin", "dshapp-plugin"],
  "license": "MIT",
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  },
  "engines": { "node": ">=22" }
}
```

逐字段说明（全部来自官方 `DshPackageManifest` 类型声明）：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | npm 包名。发布后不能再改（等于换个包）。 |
| `version` | ✅ | 必须符合 SemVer。**同一个版本号不能重复发布**，改任何东西都要 bump。 |
| `description` | 建议 | 市场列表里显示这行字。写得越清楚，别人越敢装。 |
| `type` | 建议 | 写 `"module"`，用 ESM。 |
| `main` / `exports` | ✅ | `"."` 指向 host 半；`"./client"` 指向 client 半。**两个都要导出**，少一个对应的一半就加载不了。 |
| `files` | 建议 | 打包白名单。不写会带上整个目录（包括你不想发的测试文件）。 |
| `keywords` | ✅ | **市场的唯一收录依据**，见 §7。 |
| `dsh` | ✅ | 插件元数据，见下。 |

#### `dsh` 字段详解

```jsonc
"dsh": {
  // 清单格式版本，当前固定为 1。独立于包版本与 Session 格式版本。
  "manifestVersion": 1,

  // 告诉引擎这个包是个 bundle，以及要把哪个 patch 文件应用上去。
  // 可以是单个路径，也可以是有序数组（按顺序依次应用）。
  "bundle": { "patch": "./cordis.patch.yml" },

  // 声明这个包有一个浏览器半。没有客户端代码就不要写这个字段。
  "client": {
    // 客户端平台标识。Web/桌面/本 App 都选 "web"。
    "platform": "web",
    // ⚠️ 这是「包名依赖」的说明性字段，不是 Cordis 服务注入！
    //    真正的服务注入写在 lib/client.js 的 exports.inject 里（见 §4）。
    "inject": [],
    // 启动第一阶段注册屏障。默认（不写）表示随共享批次加载。
    "immediately": true,
    // 除客户端基线之外额外需要的模块请求，可含子路径（如 "<pkg>/sub"）。
    // 不写 = 只用基线外部模块。React 已在基线里，直接 require("react") 即可。
    "external": []
  }
}
```

> ⚠️ **`dsh.bundle.patch` 是「能不能装上」的唯一判据。**
> 市场会检查这个字段：没有它，包会以「无法作为插件包安装」的警告出现在列表里，
> 装上去也不会被引擎加载。

#### `engines` 字段

```jsonc
"engines": {
  "node": ">=22",              // 兼容的 Node 版本
  "dsh": ">=0.2.0-rc.2"        // 兼容的 DSH 引擎版本（SemVer 范围）
}
```

> ⚠️ **`engines.dsh` 目前只是「声明」，不是「强制」。**
> 官方文档明确写着：*当前安装器和加载器不强制检查 `dsh.manifestVersion` 或
> `engines.dsh`；声明范围不会拒绝不兼容的宿主。*
> 所以别指望靠它拦住在旧引擎上的安装 —— 该做的版本判断要在代码里自己做。

#### 图标（可选）

```jsonc
"icon": "./icon.png"
```

支持 SVG / PNG / JPEG / WebP，**不得超过 256 KiB**，且 realpath 解析后必须仍在包目录内。
供引擎侧的插件展示读取。

### 2.3 cordis.patch.yml

这个文件告诉引擎：装完之后把我挂到哪个位置。

```yaml
# 把我这个 host 半挂进 profile。
- insert:
    - id: dsh-hello-dsh        # 插件唯一 id
      name: 'dsh-hello-dsh'    # 包名（就是 package.json 的 name）
```

实测这个文件被引擎自带的 `js-yaml` 解析成：

```
[{"insert":[{"id":"dsh-hello-dsh","name":"dsh-hello-dsh"}]}]
```

两点注意：

- **`name` 用引号包起来**。YAML 里 `dsh-xxx` 是安全的，但一旦包名里出现
  `:`、`@`、`*` 等字符，不加引号就会解析失败。统一加引号最省事。
- **client 半不用在这里声明**。浏览器半由引擎的 `dsh-client-modules` 依
  `package.json` 的 `dsh.client` 声明 + `exports["./client"]` 自动编入。
  在这里写它反而会重复加载。

---

## 3. 写 host 半（引擎侧）

`lib/index.js` 是引擎里跑的代码。它有两个导出：

```js
/** 声明我依赖哪些服务。引擎会等这些服务就绪后才调用 apply。 */
export const inject = ["webServer"];

/** 插件入口。引擎挂载插件时调用一次。 */
export function apply(ctx) {
	ctx.effect(() =>
		ctx.webServer.register({
			kind: "exact",
			path: "/hello-dsh/api/ping",
			handler: async (req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			},
		}),
	);
}
```

### 要点

**`inject` 是依赖声明，不是可选提示。** 你在 `apply(ctx)` 里用到的每个服务都要列进去，
否则取属性时会抛 `cannot get property "xxx" without inject`。
常见服务：

| 服务 | 用途 |
|---|---|
| `webServer` | 注册 HTTP 路由，给 client 半读写数据 |
| `webRuntime` | 信任主机校验等运行时信息 |
| `logger` | 日志（也可以用 `ctx.logger.info(...)`） |

**用 `ctx.effect()` 包住所有注册。** 它负责在插件卸载时自动清理。
不包的话热重载会留下重复注册的路由（表现为同一个入口被调用两次）。

**所有对外地址都挂 `/api/` 之外的自有前缀。** 别去占 `/api/` —— 那是引擎自己的命名空间。

**文件写在 `$DSH_HOME` 下。** 用 `node:os` 的 `homedir()` 定位，不要写死路径：

```js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(homedir(), ".dsh", "hello-dsh.json");
```

---

## 4. 写 client 半（界面侧）

`lib/client.js` 在浏览器/WebView 里跑。它**不是**普通模块 —— 必须用模块加载器
约定的外壳包起来：

```js
window.__ModuleLoader__.load({
	id: "dsh-hello-dsh",                    // 必须与 cordis.patch.yml 的 id 一致
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// 需要 React 就直接拿 —— React 属于客户端基线，无需声明 external
		// var React = require("react");

		/** 声明依赖的客户端服务。 */
		exports.inject = ["slots", "locale"];

		/** 客户端入口。 */
		exports.apply = function apply(ctx) {
			ctx.effect(() => {
				document.title = "dsh-hello-dsh loaded";
			}, "dsh-hello-dsh: title");
		};

		return module.exports;
	},
});
```

**外壳的三个部分缺一不可**：`id`、`factory`、末尾的 `return module.exports;`。
漏掉 return，加载器拿到 `undefined`，症状是整个 client 半静默不生效。

### 4.1 往界面里插东西：slot

DSH 前端用 slot 组装设置页。官方已占用的设置分节顺序：

| 顺序 | 分节 |
|---|---|
| -10 | 账号 |
| 0 | 通用 |
| 10 | 模型 |
| 15 | 插件 |
| 20 | Agent 预设 |
| 25 | 特权权限（本 App） |
| 26 | 插件市场（本 App） |

**建议第三方插件从 100 往后取**，避开官方与 App 内置分节的区间。

```js
exports.apply = function apply(ctx) {
	ctx.inject(["slots", "locale"], (scope) => {
		scope.slots.inject("settings.section", () =>
			scope.slots.register(
				{
					name: "settings.section",
					id: "dsh-hello-dsh",
					order: 100,
					label: () => "Hello DSH",
					locale: "hello-dsh",
				},
				HelloSection,
			),
		);
	});
};
```

> ⚠️ **这是最容易踩的坑：必须用 `ctx.inject(..., (scope) => ...)` 回调里的 `scope`，
> 不能用外层的 `ctx`。**
>
> Cordis 要求**当前 fiber** 自己声明过该依赖才能取服务。用外层 `ctx` 取
> `scope.remote` / `scope.locale` 会直接抛
> `cannot get property "remote" without inject`。
>
> 反过来说：**分节只要能渲染出来，就证明它的服务依赖是齐的。** 渲染不出来先查 inject。

### 4.2 样式

给插件样式表加一个带插件名的 id，避免与别的插件互相覆盖：

```js
var STYLE_ID = "dsh-hello-dsh/Hello.module.css";

function installStyles() {
	if (document.getElementById(STYLE_ID)) return () => {};
	var style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = ".hello-dsh-card { padding: 12px; border-radius: 8px; }";
	document.head.appendChild(style);
	return () => style.remove();
}
```

### 4.3 读写数据

client 半不能碰文件系统，要走 host 半注册的路由：

```js
var res = await fetch("/hello-dsh/api/ping");
var data = await res.json();
```

同源、同 cookie，和前端平时调 API 完全一样，不需要额外鉴权代码。

---

## 5. Android 兼容性约束

本 App 在 Android 上跑引擎，`process.platform === "android"`。
**有原生二进制依赖的插件在这个平台上大概率装不起来或跑不动**，发布前请自查。

### 5.1 已知高风险依赖

市场会自动扫你的依赖并打警告（不是拒绝，只是提示）。当前清单：

| 依赖 | 问题 |
|---|---|
| `sharp` / `@img/sharp-*` | 无 android 预编译二进制，需自行分发 wasm32 变体 |
| `@vscode/ripgrep` | 官方 optionalDependencies 里没有 android 变体 |
| `node-pty` | 无 android 绑定 |
| `node-addon-*` | 原生插件，官方无 android 平台包 |
| `@deepseek-ai/node-addon-*` | 同上 |
| `better-sqlite3` | 原生模块，需 android 预编译 |
| `@napi-rs/*` | N-API 原生模块，需 android 产物 |

### 5.2 平台判断

别写 `platform === "linux"`。Android 上它不是 linux：

```js
// ❌ 在 Android 上永远为 false
if (process.platform === "linux") { /* ... */ }

// ✅ 需要覆盖 Android 时显式列出
if (["linux", "android"].includes(process.platform)) { /* ... */ }
```

### 5.3 其他平台限制

- **没有内核级沙箱后端**。不要试图依赖 `bwrap`、`landlock`、`seatbelt`。
- **SELinux 不给 app 私有目录建硬链接**（`link()` 返回 `EACCES`）。
  依赖硬链接做原子发布的逻辑在 Android 上要能降级到 `rename()`。
- **`/sdcard` 上 `symlink()` 返回 `EPERM`**，`renameat2(RENAME_NOREPLACE)` 返回 `EINVAL`。
- **不要在 `apply()` 里抛异常**。没被捕获的错误会让引擎判定插件注册失败并退出，
  用户表现为**App 打不开**。所有注册逻辑都要包 try/catch：

  ```js
  export function apply(ctx) {
  	try {
  		// 注册路由、监听事件……
  	} catch (error) {
  		console.error("[dsh-hello-dsh] 注册失败，已跳过:", error);
  	}
  }
  ```

  > 这是本项目反复出问题的地方：一个插件注册失败会把整个引擎带崩，
  > 因为核心插件报 `required plugin did not activate` 时引擎直接退出。

---

## 6. 发布到 npm

### 6.1 登录

```powershell
npm login --registry=https://registry.npmjs.org/
```

### 6.2 发布

```powershell
npm publish --registry=https://registry.npmjs.org/
```

> ⚠️ **显式带 `--registry`**。本机可能配了镜像源，发到镜像上不会进官方市场。

### 6.3 发布前必做：打包干跑

**实测输出**（一个 3 文件的最小插件）：

```powershell
npm pack --dry-run --registry=https://registry.npmjs.org/
```

```
npm notice package: dsh-hello-dsh@1.0.0
npm notice Tarball Contents
npm notice 254B cordis.patch.yml
npm notice 436B lib/client.js
npm notice 387B lib/index.js
npm notice 554B package.json
npm notice total files: 4
```

对着这份清单**逐条确认** `cordis.patch.yml` 和两个 `lib/*.js` 都在里面。
`files` 白名单写错是最常见的「发布成功但装不上」根因。

### 6.4 ⚠️ 版本号不能复用

npm **不允许**覆盖已发布的版本。改了任何东西（哪怕只加一个关键词）
都必须先 bump 版本号：

```powershell
npm version patch     # 1.0.0 → 1.0.1
npm publish --registry=https://registry.npmjs.org/
```

### 6.5 ⚠️ 发布成功 ≠ 已经上线

npm 对较大的包会走**暂存发布**：命令返回 `exit 0` 并打印 `+ name@version`，
但注册表上**还没有这个版本**。

**实测踩过**：一个 45 KB 的包，`npm publish` 显示成功后立刻查注册表，
`dist-tags.latest` 仍是上一个版本、`versions` 里没有新版本。
约 **90 秒**后再查才出现。

**所以发布后必须回查确认**，不能信退出码：

```powershell
npm view dsh-hello-dsh version --registry=https://registry.npmjs.org/
```

输出是你刚发的版本号，才算真的上线了。

---

## 7. 收录进插件市场

**不需要申请、不需要提 PR、不需要联系任何人。** 市场靠 npm 关键词自动收录，
你发布时带上对应关键词就会出现在列表里。

### 7.1 两个关键词

| 关键词 | 分区 | 收录方式 |
|---|---|---|
| `dshapp-plugin` | **社区区** | 纯自动。带上它就收录，无任何门槛。 |
| `dshapp-plugin-featured` | **精选区** | 人工审核。审核通过后由维护者补上该关键词。 |

```jsonc
"keywords": [
  "dsh",                      // 建议保留，标识 DSH 生态
  "dsh-plugin",
  "dshapp-plugin"             // ← 加上这个就会被市场收录
]
```

**两个都带 = 归精选，且只出现一次**（精选优先，不会重复列出）。

### 7.2 收录是自动的，但有缓存

- 市场打开时会**实时扫一次** npm，结果缓存 **10 分钟**。
- 想让新版本立刻出现在用户手机上，让用户点市场右上角的**刷新**强制重扫。

### 7.3 ⚠️ 加关键词必须重新发版

关键词写在 `package.json` 里，所以**改关键词 = 改包 = 必须 bump 版本号重新发布**：

```powershell
# 1. 编辑 package.json，keywords 里加上 dshapp-plugin
# 2. bump 版本
npm version patch
# 3. 重新发布
npm publish --registry=https://registry.npmjs.org/
# 4. 回查确认（见 §6.5）
npm view dsh-hello-dsh version --registry=https://registry.npmjs.org/
```

只改本地 `package.json` 不发布，市场永远看不到 —— 市场读的是 **npm 上的**元数据。

### 7.4 市场如何判断「能不能装」

市场拉每个包的 **manifest**（不是搜索摘要）来提取字段，判据是：

| 字段 | 作用 |
|---|---|
| `dsh.bundle.patch` | **能装的前提**。缺了会显示「无法作为插件包安装」 |
| `dsh.client` | 有没有界面部分 |
| `dependencies` / `optionalDependencies` / `peerDependencies` | 自动扫 §5.1 的高风险依赖 |
| `description` / `license` / `repository` / `homepage` | 列表展示 |
| `keywords` | 决定归精选还是社区 |

**建议补全 `description`、`license`、`repository`** —— 一个没有描述、
没有许可证、没有仓库地址的包，用户不敢装。

### 7.5 上架自查清单

发布前逐条对一遍：

- [ ] `package.json` 有 `dsh.bundle.patch` 指向真实存在的 patch 文件
- [ ] `exports` 里 `"."` 和 `"./client"` 都指向真实存在的文件
- [ ] `cordis.patch.yml` 里的 `id` 与 client 半 `load({id})` 一致
- [ ] `files` 白名单包含 `lib/`、`cordis.patch.yml`
- [ ] `npm pack --dry-run` 输出的清单与预期一致
- [ ] `apply()` 全程包了 try/catch，注册失败不会拖垮引擎
- [ ] 版本号是新的（没发布过）
- [ ] 发布后回查 `npm view` 确认版本真的上线
- [ ] 关键词里加了 `dshapp-plugin`

---

## 8. 排错速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 发布成功但市场里没有 | 关键词没加，或版本没 bump，或缓存未过期 | 确认 npm 上元数据（`npm view <pkg> keywords`），让用户点刷新 |
| 市场显示「无法作为插件包安装」 | 缺 `dsh.bundle.patch` | 补上并重新发版 |
| 市场里显示的是旧版本 | 缓存 10 分钟 | 点刷新；或等缓存过期 |
| 装上后界面没变化 | client 半外壳漏了 `return module.exports;` | 检查 factory 末尾 |
| 客户端报 `cannot get property "xxx" without inject` | 用了外层 `ctx` 而不是 `ctx.inject` 的 `scope` | 见 §4.1 |
| 插件装不上、引擎起不来 | `apply()` 抛异常把引擎带崩 | 全部注册逻辑包 try/catch（§5.3） |
| 设置页里两个插件的样式互相覆盖 | 样式没加唯一 id | 给 `<style>` 设带插件名的 `id` |
| `npm publish` 报版本已存在 | 同版本不能重复发布 | `npm version patch` 后重发 |
| `npm publish` 成功但 `npm view` 查不到 | 暂存发布，约 90 秒后才上线 | 等一下再查，别重复发 |
| Android 上插件功能失效但没报错 | 依赖了没有 android 变体的原生模块 | 对照 §5.1 |

---

## 附：最小完整示例

把下面 4 个文件放进一个目录，就是一个能发布、能上架、能在 App 里装上的插件。

**`package.json`**

```json
{
  "name": "dsh-hello-dsh",
  "version": "1.0.0",
  "description": "示例插件：注册一个 ping 路由，并把标题改掉。",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "keywords": ["dsh", "dsh-plugin", "dshapp-plugin"],
  "license": "MIT",
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  },
  "engines": { "node": ">=22" }
}
```

**`cordis.patch.yml`**

```yaml
- insert:
    - id: dsh-hello-dsh
      name: 'dsh-hello-dsh'
```

**`lib/index.js`**

```js
/** Host half: registers one web route. */
export const inject = ["webServer"];

const ROUTE = "/hello-dsh/api/ping";

export function apply(ctx) {
	try {
		ctx.effect(() =>
			ctx.webServer.register({
				kind: "exact",
				path: ROUTE,
				handler: async (req, res) => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				},
			}),
		);
	} catch (error) {
		console.error("[dsh-hello-dsh] 注册失败，已跳过:", error);
	}
}
```

**`lib/client.js`**

```js
window.__ModuleLoader__.load({
	id: "dsh-hello-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		exports.inject = [];
		exports.apply = function apply(ctx) {
			ctx.effect(() => {
				document.title = "dsh-hello-dsh loaded";
			}, "dsh-hello-dsh: title");
		};

		return module.exports;
	},
});
```

发布：

```powershell
npm pack --dry-run --registry=https://registry.npmjs.org/   # 确认白名单
npm publish   --registry=https://registry.npmjs.org/         # 发布
npm view dsh-hello-dsh version --registry=https://registry.npmjs.org/   # 回查确认
```

发完之后，在 App 的**设置 → 插件市场 → 刷新**里就能看到它。
