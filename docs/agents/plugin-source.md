# ⑬ 添加插件少了「npm 官方源」

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑬ 「添加插件」对话框少了「npm 官方源」—— 不是漏配，是被去重合并掉了

**症状**：手机端对话框的「安装源」下拉只有**一项**（中国大陆镜像源）+ 自定义地址，
桌面端有两项（npm 官方源 + 中国大陆镜像源）+ 自定义地址。功能没坏（选「自定义地址」
填 `https://registry.npmjs.org/` 等效），但看起来像手机端少了功能。

**根因：列表是官方前端按 URL 动态去重算出来的，三处来源撞成了同一个 URL。**

`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js` 的 `offeredRegistries()`
遍历三处、按 `normalizeRegistry()` 归一化后去重：

```
[config.registry] + [config.fallbackRegistries] + [pnpm 自身配置(~/.npmrc) 指的源]
```

而 `@deepseek-ai/dsh-plugin-manager` 的 `fallbackRegistries` **默认值就是**
`NPMMIRROR_REGISTRY`。本机 `MirrorProbe` 测速后把
`registry=https://registry.npmmirror.com` 写进了 `~/.npmrc`，于是三项归一化后
**全是同一个 URL** ⇒ 去重后只剩一项。桌面版 `.npmrc` 指的是官方源，与 fallback
不同 ⇒ 两项都留下。**所以这是「被合并」而不是「少配了」。**

**做法**：`EngineManager.writePluginManagerPatch()` 生成
`$DSH_HOME/plugin-manager.patch.yml`，显式声明两项：

```yaml
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  config:
    registry: 'https://registry.npmmirror.com/'
    fallbackRegistries:
      - 'https://registry.npmmirror.com/'
      - 'https://registry.npmjs.org/'
```

⚠️ **`fallbackRegistries` 里必须也放镜像源**，不能只放官方源。`registryPlan()` 有：

```js
const ownIsPublic = own !== null && (own === "https://registry.npmjs.org/" || fallbacks.includes(own));
...
if ((first === null || firstKey === own) && !ownIsPublic) return [normalizedFirst];
```

`own` 是 pnpm 自己报的源（本机 = npmmirror）。fallback 里不放它 ⇒ `ownIsPublic`
为 false ⇒ 安装**只试一个源、没有回退**。放了 ⇒ 列表是 `[npmmirror, npmjs]`
（镜像在前，与桌面版顺序一致），且安装先走镜像、失败自动回退官方源。

⚠️ **URL 必须逐字与官方常量一致，含尾斜杠。** `normalizeRegistry()` 会给 pathname
补尾斜杠，所以 `.npmrc` 里无斜杠的写法归一化后也相同（去重键能对齐）；但我们自己
写进 overlay 的常量要带斜杠，免得读者以为两者不同。出处：
`dsh-plugin-manager/lib/index.js` 的 `NPMMIRROR_REGISTRY`。

⚠️ **`name` 必须与 base 层逐字一致**，否则 `applyEntryPatches()` 打
`patch: name mismatch ... skipping` **整条静默跳过**（只在日志里 warn）。
只写 `config:` **不会**动 base 层那行的 `disabled: !!js ...` —— patch 是
**逐字段覆盖**（`target[key] = value`），不是整行替换。

**为什么用 `--patch` 而不是用户层**：`plugin-manager` 的 `inject` 里**没有
`settings`**，这两项不是 GUI 设置项（`settings/describe` 里没有），用户无从覆盖 ——
不存在「锁死用户配置」的问题。与 `writeSandboxPatch()` / `writeWorkspacePatch()` 同类，
每次启动整体覆盖。

日志验收：`已写入插件源 overlay: plugin-manager.patch.yml`，且启动命令行里能看到
`--patch .../plugin-manager.patch.yml`，同时**不应**出现 `name mismatch`、
`entry not found`、`did not activate` / `pending`。

