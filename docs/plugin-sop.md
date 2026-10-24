# DSH 插件交付标准流程（SOP）

> **这份文档规定「从一句需求到一个装得上的插件」的标准做法。**
>
> 面向两类读者：
> - **用户**：你只需要说清想要什么（§1），剩下的由 AI 执行。
> - **AI**：被要求做插件时，**按 §2 的六步走**，不要跳步、不要即兴发挥。
>
> 目的：把「写插件」从一门手艺变成一条流水线 —— 同样的需求，
> 谁来执行都产出同样结构的包，且**在发布前就已经被验证过**。

---

## 1. 用户怎么说清需求

你不需要懂插件、不需要提任何技术名词。**说清「什么场景下、你想让它做什么」就够了。**

### 模板

```
我想要一个插件，它能在 <什么时候> 帮我 <做什么>。
<可选> 我希望它能出现在 <哪里>，长成 <什么样>。
```

### 好例子

| 你说的 | AI 会补上的技术判断 |
|---|---|
| 「每次会话标题都是自动生成的，我想让它按我的习惯改」 | 需要监听会话事件 + 一个设置页入口 → host 半 + client 半 |
| 「我想在输入框上面加一个快捷按钮」 | 需要插进界面 → client 半往 slot 注册 |
| 「我想让 AI 每次回复前先读我的某个文件」 | 需要拦对话流程 → host 半监听事件 |
| 「我想把常用的一段提示词变成 `/` 命令」 | 需要注册命令 → host 半 |

### 你不需要告诉 AI 的事

以下全部由 AI 决定，**你不用操心**：

- 要写几个文件、叫什么名字
- 用不用 React、要不要界面
- `package.json` 里那些字段
- 插件 id 怎么起
- 怎么打包、怎么上传、怎么上架

**你唯一要拍板的**：这个插件**具体要干什么**（业务逻辑），以及最后**界面好不好看、用着顺不顺手**（§5 的视觉确认）。

---

## 2. AI 执行流程（六步，不许跳步）

```
① 需求 → 形态判定
② 生成插件包（骨架 + 业务逻辑）
③ 本机自测（不起 App，必须先全绿）
④ 交付给用户装到手机上试
⑤ 发布到 npm
⑥ 上架市场 + 回查
```

---

### 第 ① 步：需求 → 形态判定

先判**要不要界面**，这决定了包的形状：

| 需求特征 | 形态 | 要写的文件 |
|---|---|---|
| 只改引擎行为、加工具/命令、读写数据 | **纯 host** | `package.json` + `cordis.patch.yml` + `lib/index.js` |
| 要在界面上加东西、改样式、加面板 | **host + client** | 上面三个 + `lib/client.js` |

判据：**用户能看到或用鼠标点的，就是 client 半。** 后台跑的、给 AI 用的，就是 host 半。

⚠️ 拿不准时按「host + client」做 —— 多一个空的 host 半不影响功能，
但少了 client 半就要返工重发版本（npm 版本号不能复用）。

产出：一句形态结论 + 文件清单。**先跟用户确认这一条再往下做。**

---

### 第 ② 步：生成插件包

按 §3 的骨架填业务逻辑。三条铁律：

1. **包名用自己的作用域**（`@你的用户名/xxx`）或裸名。
   **绝不要用 `@deepseek-ai/`** —— 那是官方作用域，你发不出去。
2. **`apply()` 里的一切都包 try/catch。** 插件注册失败会拖垮整个引擎，
   用户表现是 **App 打不开**。这是本平台最严重的事故类型。
3. **`cordis.patch.yml` 的 `id`、client 半 `load({id})` 的 id 必须一致。**

产出：一个完整目录，`npm pack --dry-run` 能列出预期的文件。

---

### 第 ③ 步：本机自测（**发布前必须全绿**）

这一步**不需要装 App、不需要起引擎**，在开发机上就能跑完。
它验证的是「包的结构对不对」，是所有后续步骤的前提。

```powershell
# 3.1 两半的语法
node --check lib/index.js
node --check lib/client.js

# 3.2 打包白名单：确认 cordis.patch.yml 和 lib/*.js 都在清单里
npm pack --dry-run --registry=https://registry.npmjs.org/
```

3.3 **结构一致性 + 真跑一遍两半的逻辑**

把下面的 `selfcheck.mjs` 放进插件目录，再拿一份 `js-yaml.mjs`（见 3.4），
然后 `node selfcheck.mjs`。**这套脚本已在本项目实跑验证：干净包 19/19 全绿，
且七种真实缺陷全部能抓到（见下方对照表）。**

```js
// selfcheck.mjs —— 用法: node selfcheck.mjs
import { readFileSync } from "node:fs";
import yaml from "./js-yaml.mjs";

let pass = 0, fail = 0;
/** 一项检查：抛异常也算失败，但不中断其余检查。异步函数会被 await。 */
const check = async (label, fn) => {
	try {
		const r = await fn();
		r ? (pass++, console.log(`  ✅ ${label}`)) : (fail++, console.log(`  ❌ ${label}`));
	} catch (e) {
		fail++;
		console.log(`  ❌ ${label}  【${e.constructor.name}: ${String(e.message).split("\n")[0]}】`);
	}
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const rel = (p) => p.replace(/^\.\//, "");

// ── 声明与文件必须对得上 ──
await check("dsh.bundle.patch 指向的文件存在", () => readFileSync(rel(pkg.dsh.bundle.patch), "utf8").length > 0);
await check("exports['.'] 指向的文件存在", () => readFileSync(rel(pkg.exports["."]), "utf8").length > 0);
await check("exports['./client'] 指向的文件存在", () => readFileSync(rel(pkg.exports["./client"]), "utf8").length > 0);
await check("exports['.'] 与 main 一致", () => pkg.exports["."] === "./" + pkg.main);

// ── patch 文件结构与 id 一致性 ──
let patchDoc = null;
await check("cordis.patch.yml 可解析", () => { patchDoc = yaml.load(readFileSync(rel(pkg.dsh.bundle.patch), "utf8")); return patchDoc !== null; });
const patchId = patchDoc?.[0]?.insert?.[0]?.id;
const patchName = patchDoc?.[0]?.insert?.[0]?.name;
await check("patch 结构 = [{insert:[{id,name}]}]", () => Boolean(patchId && patchName));
await check("patch 的 name 等于包名", () => patchName === pkg.name);

// ── host 半：mock ctx 真调一次 apply ──
let host = null;
await check("host 半可 import", async () => { host = await import("./lib/index.js"); return true; });
if (host) {
	await check("host 导出 apply 函数", () => typeof host.apply === "function");
	await check("host 导出 inject 数组", () => Array.isArray(host.inject));
	const registered = [];
	const mockCtx = {
		effect: (fn) => fn(),               // 立即执行，拿到清理函数
		webServer: { register: (r) => { registered.push(r); return () => {}; } },
		logger: { info: () => {}, warn: () => {} },
		on: () => () => {},
	};
	await check("host apply 不抛异常", () => { host.apply(mockCtx); return true; });
	await check(`host 注册了路由 (${registered.length} 条)`, () => registered.length > 0);
} else {
	await check("host 导出 apply 函数  【host 半未能加载，见上一项】", () => false);
	await check("host 导出 inject 数组  【同上】", () => false);
	await check("host apply 不抛异常  【同上】", () => false);
	await check("host 注册了路由  【同上】", () => false);
}

// ── client 半：模拟浏览器环境后真加载一次 ──
global.document = {                     // client 半跑在浏览器里，node 下要补 mock
	title: "",
	head: { appendChild: () => {} },
	body: { setAttribute: () => {} },
	getElementById: () => null,
	createElement: () => ({ set textContent(_v) {}, id: "", dataset: {}, appendChild: () => {}, remove: () => {} }),
	querySelector: () => null,
	documentElement: {},
};

let loaded = null;
await check("client 半可执行并调用 __ModuleLoader__.load", () => {
	global.window = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
	new Function(readFileSync(rel(pkg.exports["./client"]), "utf8"))();
	return loaded !== null;
});
await check("client 的 id 与 patch 的 id 一致", () => loaded?.id === patchId);
await check("factory 是函数", () => typeof loaded?.factory === "function");

let exported = null;
await check("factory 返回对象（外壳没漏 return）", () => {
	exported = loaded.factory(() => { throw new Error("no baseline module in selfcheck"); });
	return exported !== null && typeof exported === "object";
});
await check("client 导出 apply 函数", () => typeof exported?.apply === "function");
await check("client 导出 inject 数组", () => Array.isArray(exported?.inject));
await check("client apply 不抛异常", () => { exported.apply({ effect: (fn) => fn() }); return true; });

console.log(`\n自测: 通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
```

**这套自测抓得到什么**（每一条都做过反向验证：故意注入缺陷，确认脚本报红）：

| 故意注入的缺陷 | `node --check` 能发现吗 | 自测结果 |
|---|---|---|
| `apply()` 里引用未定义变量 | ❌ 发现不了（exit 0） | ❌ 5 项失败，报 `ReferenceError` |
| client 外壳漏 `return module.exports` | ❌ 发现不了（exit 0） | ❌ 4 项失败 |
| `exports["./client"]` 指向不存在的文件 | ❌ 发现不了 | ❌ 8 项失败，报 `ENOENT` |
| client `id` 与 patch `id` 不一致 | ❌ 发现不了 | ❌ 1 项失败 |
| 缺 `dsh.bundle.patch` | ❌ 发现不了 | ❌ 5 项失败 |
| `cordis.patch.yml` 缩进错误 | ❌ 发现不了 | ❌ 4 项失败，报 `YAMLException` |

> **`node --check` 只查语法，`.` 以上六类它一个都抓不到。**
> 这就是为什么第③步必须跑 `selfcheck.mjs`，而不是「语法过了就发布」。
>
> 关键设计：**`apply()` 要用 mock ctx 真的调一次**。
> 只做静态检查发现不了「导入了不存在的服务」「effect 里写了未定义变量」这类运行时问题 ——
> 而它们恰恰是「用户装上后 App 打不开」的直接原因。

3.4 取一份 `js-yaml.mjs`（引擎自带，用来验 patch 文件）：

```powershell
# 从 App 的引擎包里解出来（路径按你的仓库调整）
tar -xzf app/src/main/assets/engine.bin -C . "node_modules/js-yaml/dist/js-yaml.mjs"
Copy-Item node_modules/js-yaml/dist/js-yaml.mjs <插件目录>/js-yaml.mjs
```

> `js-yaml.mjs` 只是给自测脚本用的，**不要写进 `files` 白名单**，别打进插件包。

**③ 全绿之前，不要进第 ④ 步。** 这一步漏了，问题会在用户手机上暴露，
而那时你已经发了一个版本出去 —— 而 npm 版本号不能复用。

产出：自测输出（通过/失败数）。**必须是全绿的具体行，不是「退出码 0」。**

---

### 第 ④ 步：交付给用户装到手机上试

**这一步是人的判断，不要自己反复截图自测。** 把状态准备好，用编号写清怎么试：

```
插件已生成在：<路径>

请在 App 上验证：
1. 把 <包目录> 推到手机 $DSH_HOME 下（AI 可直接代劳）
2. 重启 App
3. 打开 设置 → 插件，确认列表里有 <插件名>，且没有报错
4. <本插件特有的操作步骤>
5. 应看到：<具体现象>
```

⚠️ **不要在这步反复截图自测来替代人的判断。** 视觉与手感只有用户能定。
用户说「可以了」就进 ⑤，说「不行」就回来改。

产出：用户确认（明确说「通过 / 没问题 / 可以了」）。

---

### 第 ⑤ 步：发布到 npm

```powershell
# 5.1 确认版本号是新的（改过任何东西都要 bump）
npm version patch

# 5.2 发布 —— 必须显式带 --registry
npm publish --registry=https://registry.npmjs.org/

# 5.3 ⚠️ 回查确认（见下）
npm view <包名> version --registry=https://registry.npmjs.org/
```

#### ⚠️ 两个必须知道的陷阱

**陷阱一：`npm publish` 成功 ≠ 已经上线。**
npm 对较大的包会走**暂存发布**：命令返回 exit 0、打印 `+ name@version`，
但注册表上**还没有这个版本**。本项目实测：一个 45 KB 的包，
发布成功后立刻查 `dist-tags.latest` 仍是旧版本，约 **90 秒**后才更新。

**所以 5.3 的回查不是可选项。** 输出是刚发的版本号，才算真的上线。

**陷阱二：同一个版本号不能重复发布。**
哪怕只改一个关键词也要 bump 版本，否则 `npm publish` 直接报错。

产出：`npm view` 回查输出。

---

### 第 ⑥ 步：上架市场 + 回查

**不需要申请、不需要提 PR。** 市场扫 npm 关键词自动收录，判据是你包里 `keywords` 数组：

| 关键词 | 分区 | 收录方式 |
|---|---|---|
| `dshapp-plugin` | **社区区** | 纯自动，带上就收录，无门槛 |
| `dshapp-plugin-featured` | **精选区** | 人工审核后由维护者补上 |

#### ⚠️ 关键词是写在 `package.json` 里的，所以「上架」= 「改关键词 + 重发」

发布之后才想起要上架，也要走完整一套（**不能只改本地文件**，市场读的是 npm 上的元数据）：

```powershell
# 1. 编辑 package.json，keywords 加进 "dshapp-plugin"
# 2. bump 版本（同版本不能重发）
npm version patch
# 3. 重发
npm publish --registry=https://registry.npmjs.org/
# 4. 回查关键词真的生效了
npm view <包名> keywords --registry=https://registry.npmjs.org/
```

第 4 步期望看到 `dshapp-plugin` 在数组里。**看不到就是没生效，别靠猜。**

#### 收录延迟

市场打开时实时扫 npm，结果**缓存 10 分钟**。想让用户立刻看到，
让他在**设置 → 插件市场**点刷新强制重扫。

产出：`npm view <包名> keywords` 的输出（含收录关键词）。

---

## 3. 骨架模板（AI 直接抄，只填业务逻辑）

### 3.1 目录

```
<包名>/
├── package.json
├── cordis.patch.yml
├── lib/
│   ├── index.js      # host 半（必需）
│   └── client.js     # client 半（要界面才需要）
└── README.md         # 建议：写清这个插件干什么
```

### 3.2 package.json

```json
{
  "name": "<包名>",
  "version": "1.0.0",
  "description": "一句话说清这个插件干什么 —— 市场列表里显示的就是它。",
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

关键字段的判据（来自引擎自带的权威声明 `@deepseek-ai/dsh-package-manifest`）：

| 字段 | 作用 | 漏了会怎样 |
|---|---|---|
| `dsh.bundle.patch` | **能不能被安装的唯一判据** | 市场标「无法作为插件包安装」，装了也不加载 |
| `exports["."]` | host 半入口 | 引擎解析不到，启动报错 |
| `exports["./client"]` | client 半入口 | 界面部分**静默不生效**（不报错，最难查） |
| `keywords` | 市场收录依据 | 不会出现在市场里 |
| `files` | 打包白名单 | 不在白名单的文件不会进包 |

> `engines.dsh` 目前**只是声明、不被强制校验**（官方文档明说）。
> 别指望靠它拦住旧引擎上的安装，版本判断要在代码里自己做。

### 3.3 cordis.patch.yml

```yaml
- insert:
    - id: <插件id>
      name: '<包名>'
```

- `name` **统一加引号**（含 `@` `:` `*` 的包名不加引号会解析失败）。
- **client 半不要写在这里** —— 它由引擎依 `dsh.client` 声明自动加载，写了会重复。
- `id` 必须与 client 半 `load({id})` 一致。

### 3.4 lib/index.js（host 半）

```js
/** 声明依赖的服务。用到哪个写哪个，漏了会抛 "without inject"。 */
export const inject = ["webServer"];

/** 插件入口：引擎挂载时调用一次。 */
export function apply(ctx) {
	try {
		// 注册路由（client 半靠它读写数据）
		ctx.effect(() =>
			ctx.webServer.register({
				kind: "exact",
				path: "/<插件id>/api/ping",
				handler: async (req, res) => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				},
			}),
		);

		// 监听事件
		ctx.effect(() => {
			const dispose = ctx.on("session/event", (session, event) => {
				// 业务逻辑
			});
			return dispose;
		}, "<插件id>: session events");
	} catch (error) {
		// ⚠️ 绝不能让它冒泡 —— 会让整个引擎启动失败，用户 App 打不开
		console.error("[<插件id>] 注册失败，已跳过:", error);
	}
}
```

常用服务：

| 服务 | 用途 |
|---|---|
| `webServer` | 注册 HTTP 路由，给 client 半读写数据 |
| `webRuntime` | 信任主机校验等运行时信息 |
| `logger` | 日志（也可直接用 `ctx.logger.info(...)`） |

**约定**：
- 所有路由挂**自己的前缀**，不要去占 `/api/`（引擎的命名空间）。
- 数据文件写在 `$DSH_HOME` 下，用 `homedir()` 定位，不要写死路径。

### 3.5 lib/client.js（client 半）

```js
window.__ModuleLoader__.load({
	id: "<插件id>",                          // 必须与 cordis.patch.yml 一致
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// React 在客户端基线里，直接拿：
		// var React = require("react");

		/** 声明依赖的客户端服务。 */
		exports.inject = ["slots", "locale"];

		/** 客户端入口。 */
		exports.apply = function apply(ctx) {
			ctx.effect(() => {
				// 业务逻辑
				document.title = "<插件id> loaded";
			}, "<插件id>: title");
		};

		return module.exports;   // ⚠️ 漏了这行，整个 client 半静默失效
	},
});
```

**外壳三件套缺一不可**：`id`、`factory`、末尾的 `return module.exports;`。

#### 往界面插东西：slot

```js
exports.apply = function apply(ctx) {
	ctx.inject(["slots", "locale"], (scope) => {
		scope.slots.inject("settings.section", () =>
			scope.slots.register(
				{
					name: "settings.section",
					id: "<插件id>",
					order: 100,                 // 见下表
					label: () => "我的插件",
					locale: "<插件id>",
				},
				MySection,                      // React 组件
			),
		);
	});
};
```

官方已占用的设置分节顺序：

| order | 分节 |
|---|---|
| -10 | 账号 |
| 0 | 通用 |
| 10 | 模型 |
| 15 | 插件 |
| 20 | Agent 预设 |
| 25 | 特权权限（本 App） |
| 26 | 插件市场（本 App） |

**第三方插件从 100 往后取**，避开官方与内置分节的区间。

> ### ⚠️ 最常踩的坑：必须用 `scope`，不能用外层 `ctx`
>
> ```js
> // ❌ 抛 "cannot get property 'remote' without inject"
> ctx.inject(["slots", "locale"], (scope) => { ctx.slots.register(...) });
>
> // ✅
> ctx.inject(["slots", "locale"], (scope) => { scope.slots.register(...) });
> ```
>
> Cordis 要求**当前 fiber 自己声明过该依赖**才能取服务。外层 `ctx` 没声明。
> 反过来：**分节只要渲染得出来，就证明依赖是齐的**；渲染不出来先查这里。

#### 样式

给 `<style>` 加带插件名的 id，避免与其他插件互相覆盖：

```js
var STYLE_ID = "<插件id>/My.module.css";
```

---

## 4. Android 平台约束（发布前必查）

本 App 在 Android 上跑引擎，`process.platform === "android"`。

### 4.1 高风险依赖（市场会自动扫出来并警告）

| 依赖 | 问题 |
|---|---|
| `sharp` / `@img/sharp-*` | 无 android 预编译，需自行分发 wasm32 变体 |
| `@vscode/ripgrep` | 官方 optionalDependencies 里没有 android 变体 |
| `node-pty` | 无 android 绑定 |
| `node-addon-*` / `@deepseek-ai/node-addon-*` | 原生插件，官方无 android 平台包 |
| `better-sqlite3` | 原生模块，需 android 预编译 |
| `@napi-rs/*` | N-API 原生模块，需 android 产物 |

**能用纯 JS 实现就绝不要引原生依赖。** 这是 Android 上插件失效的头号原因，
而且是静默的 —— 不报错，功能就是不工作。

### 4.2 平台判断不要写 `linux`

```js
// ❌ Android 上永远为 false
if (process.platform === "linux") { /* ... */ }

// ✅
if (["linux", "android"].includes(process.platform)) { /* ... */ }
```

### 4.3 其他限制

- **没有内核级沙箱后端**（无 `bwrap` / `landlock` / `seatbelt`），别依赖它们。
- **SELinux 不给 app 私有目录建硬链接**（`link()` → `EACCES`）。
  依赖硬链接做原子发布的逻辑要能降级到 `rename()`。
- **`/sdcard` 上 `symlink()` → `EPERM`**，`renameat2(RENAME_NOREPLACE)` → `EINVAL`。
- **`apply()` 绝不能抛异常**（见 §2 第②步铁律 2）。

---

## 5. 验收：谁验什么

**这一步是分工的界线，别越界。**

| 验什么 | 谁验 | 怎么验 |
|---|---|---|
| 语法、打包清单、结构一致性、`apply()` 能跑 | **AI 自己** | §2 第③步，必须全绿 |
| 版本真的上线了 | **AI 自己** | `npm view` 回查（§2 第⑤步） |
| 关键词真的生效了 | **AI 自己** | `npm view <包名> keywords`（§2 第⑥步） |
| 装到手机上能不能用 | **用户** | §2 第④步，AI 准备状态并写清步骤 |
| 界面好不好看、用着顺不顺手 | **用户** | AI **不要**反复截图自测替代人的判断 |

⚠️ **「构建成功」不等于「改动生效」，「测试通过」不等于「测试真跑了」。**
AI 自验时必须能看到具体证据（断言的通过数、注册了几条路由、回查的版本号），
而不是「命令退出码是 0」。

⚠️ 用户说「可以了 / 没问题 / 通过」= **验收通过，立即收尾**，
不要再补测一轮，也不要追问「要不要再测测别的」。

---

## 6. 排错速查

| 症状 | 根因 | 处理 |
|---|---|---|
| 装完插件、引擎起不来（App 打不开） | `apply()` 抛异常拖垮了引擎 | 全部注册逻辑包 try/catch（§3.4） |
| 界面部分完全没反应，也不报错 | client 外壳漏 `return module.exports;` | 检查 factory 末尾（§3.5） |
| 报 `cannot get property "xxx" without inject` | 用了外层 `ctx` 而不是 `scope` | 见 §3.5 的坑 |
| 市场里没有我的插件 | 关键词没加 / 版本没 bump / 缓存未过期 | `npm view <包名> keywords` 确认，让用户点刷新 |
| 市场显示旧版本 | 缓存 10 分钟 | 点刷新；或等缓存过期 |
| 市场标「无法作为插件包安装」 | 缺 `dsh.bundle.patch` | 补上并 bump 版本重发 |
| 发布成功但 `npm view` 查不到 | 暂存发布，约 90 秒后上线 | 等一下再查，**别重复发** |
| `npm publish` 报版本已存在 | 同版本不能重发 | `npm version patch` 后重发 |
| Android 上功能失效但不报错 | 引了没有 android 变体的原生模块 | 对照 §4.1 |
| 设置页里两个插件样式互相覆盖 | `<style>` 没加唯一 id | 见 §3.5 样式 |

---

## 7. 一页速查（贴给 AI 用）

```
需求 → ① 判形态（要不要界面？）→ 先跟用户确认
     → ② 生成包（骨架抄 §3，apply 包 try/catch，id 三处一致）
     → ③ 本机自测（node --check + npm pack --dry-run + selfcheck.mjs 全绿）
     → ④ 用户装到手机试（AI 准备步骤，不替用户做视觉判断）
     → ⑤ npm publish + npm view 回查（别信 exit 0）
     → ⑥ keywords 加 dshapp-plugin + 重发 + npm view keywords 回查
```

**三条不许违反的**：
1. 包名不许用 `@deepseek-ai/` 前缀。
2. `apply()` 必须全包 try/catch —— 否则用户 App 打不开。
3. 第③步没全绿，不许进第④步。
