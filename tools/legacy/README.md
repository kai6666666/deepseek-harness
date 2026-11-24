# tools/legacy/ —— 已废弃但留档的工具

这里放的是**已经被推翻或已被取代**的脚本。保留它们只为一件事：以后有人再想走同一条路时，
能先看到「为什么这条路走不通」。

**不要在这里新增脚本。** 新工具请放 `tools/` 根目录。

---

## `plugin-readme.py` —— 补插件 `README.md`（**方案错误**）

**它想解决什么**：插件详情页报「插件声明的详细介绍文件无效」。

**它怎么做的**：从 jsDelivr / npm packument 把每个包的 `README.md` 抓回来，塞进 runtime 的
`node_modules/<pkg>/README.md`，产物是 `<out>/<扁平路径>/README.md` + `readme.map`。

**为什么错**（2026-11-23 真机定位，见 `docs/agents/plugin-data-repair.md`）：

1. 官方详情渲染 `@deepseek-ai/dsh-plugin-detail` 读的是 **`docs/DETAIL.md` / `docs/DETAIL.zh.md`**，
   不是 `README.md`。拿 `README.md` 去填，判定依然是「无效」。
2. 更麻烦的是包旁边的 `README.i18n.yaml` —— 它是**双语区块的哈希旁签**（形如
   `/summary:\n  en: 5508a3…\n  zh: dae436…`），不是正文。手工塞进去的 README 与哈希对不上，
   于是**产生了新的「无效」**。
3. 真正该修的是 `tools/runtime/build-runtime.sh` 里两条删除规则（删 `*.md` 时误伤、
   删整个 `docs/` 目录），以及用 `tools/plugin-docs.py` 把 `docs/` 补回来。

**正确方案**：`tools/plugin-docs.py`（在 `tools/` 根目录，仍在使用）。
它的文件头写着上面这两条根因，遇到同类问题直接读那段注释。

---

## 未归档但无人引用的脚本（**故意保留**）

以下几类在 2026-11-24 的引用审计里被判定「无任何文件引用」，但它们是**手动工具**，
不是一次性探针，所以留在原处：

| 脚本 | 判断 |
|---|---|
| `tools/probe-vmos.mjs` | 探测 VMOS+ 的 adb 端点与 ROM 能力；换环境时还会用 |
| `tools/ui-drive.mjs`、`tools/ui-standalone.mjs` | UI 手动驱动脚本 |
| `tools/uiagent-device-audit.mjs`、`uiagent-device-drive.mjs`、`uiagent-probe-endpoints.mjs`、`uiagent-state-snapshot.mjs` | UI Agent 设备侧工具 |

如果将来确认它们也不再用，按同样格式迁移到本目录并写明原因。
