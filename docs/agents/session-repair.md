# ⑨.5 / ⑨.6 会话永久损坏的两种形态

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑨.5 API 错误中断后会话**永久发不出去** —— assistant 的 `tool_use` 块顺序

**症状（严重，会话级永久损坏）**：某一轮因为 **API 错误**结束时（实测是第三方路由的
`429 RATE_LIMIT`），**该会话此后的每一条消息都失败**，连「只回复两个字：通了」
这种最简消息也一样：

```
本轮运行失败 messages.7.1: `tool_use` ids were found without `tool_result`
blocks immediately after: call_f0dd74e854fd4cb1a0a6ee0a. (INVALID_REQUEST)
```

**新建会话不受影响** —— 所以这是**历史消息**的问题，不是当前请求的问题。
UI 上表现为「处理失败」，`INVALID_REQUEST` 是错误码。

⚠️ **触发它的不是用户点「停止生成」**（实测那条路径完全正常，中断后会话照常可用），
而是 **API 侧的错误中断**：那一轮的 assistant 消息已经带上了 `tool_use` 块，
但永远等不到对应的 `tool_result`，历史就此定形。

**根因**：`dsh-llm-deepseek/lib/index.js` 的 `serialize()` 把 assistant 消息的
content 块**原样保序**映射成 `tool_use` / `text` / `thinking`，而持久化历史里
assistant 的实际形状是**交错的**（模型先说一句、再调工具、再说一句、再调工具）：

```
["tool_use:call_e6d1…", "text(3)", "tool_use:call_a47f…", "tool_use:call_2399…"]
```

而 DeepSeek Messages API 要求 assistant 的 `tool_use` 块**必须连续**，且紧后必须
是携带全部 `tool_result` 的 user 消息。夹在中间的 `text` 直接违约。

⚠️ **引擎自己的自检抓不到它**：`serialize()` 末尾那个 `pending` 循环**只查 id 配对、
不查块顺序**，所以这种历史在本地自检里是「合法」的，只有真发给 API 才炸。

⚠️ **引擎其实已经对 user 消息做了同样的重排**（`[...results, ...其余]`，就是修
「tool_result 必须在前」的那一行），**只是漏了 assistant 这一侧**。这个补丁补的就是
那处遗漏。

**做法**：`EngineManager.patchLlmDeepseekToolOrder()` 把 `assistant()` 的
`return message.content.map(...)` 拆成先赋给 `const mapped`，再补一次稳定重排 ——
**把 `tool_use` 收敛到末尾**，其余块保持原有相对顺序。锚点 `TOOL_ORDER_GUARD_HEAD` /
`TOOL_ORDER_GUARD_TAIL`（首尾两行，不是整段照抄，免得无关空白变化就失配）。

⚠️ **方向是「置尾」而不是「置首」**：assistant 的 content 首块常是 `reasoning`
（映射成 `thinking`），而 Messages API 要求 thinking 排在 assistant content 的**最前**。
把 `tool_use` 提到最前会让 thinking 落到它后面，可能触发签名校验失败。收敛到末尾
得到的 `[thinking, text, tool_use…]` 才是规范形状。

⚠️ **重排必须发生在 `map` 之后**：`readReplay()` 返回的签名数组是**按下标**与
`message.content` 对齐的，`assistant()` 在 `map` 里用 `replay[index]` 取签名。
若在 `map` 之前重排 `message.content`，签名会串位。补丁插在 `map` 的外层正是这个位置。

⚠️ **只改 wire 请求体，不改持久化历史**：`assistant()` 返回的是新数组，
`message.content` 本身不被改写，会话日志与 UI 显示都不受影响。真机实测修复后
日志里 assistant 仍是交错的 37 个 `tool-call`，证明没有回写。

**真机验收**（同一个已卡死的会话 `session-c470b9d5`，21 轮历史，其中两条
`INVALID_REQUEST`）：

| | 修复前 | 修复后 |
|---|---|---|
| 「只回复两个字：通了」 | `INVALID_REQUEST` | `已完成，用时 15秒` → 回复「通了」 |
| 多工具任务（3 步 bash） | — | `turn/end kind=completed`，产物 `e2e-multi/x.txt` = `MULTI_OK` |

日志：`已修正 DeepSeek Messages 的 tool_use 块顺序: dsh-llm-deepseek`。
幂等：第二次启动不再打印该行（`contains(TOOL_ORDER_ANCHOR_HEAD)` 命中即返回），
补丁文本仍只有 1 处。

⚠️ 离线复刻验证（把会话日志按 `serialize()` 的逻辑重建 wire messages）：
现状 **24 处违例**（`messages.1/7/13/21/…`，报错里的 `messages.7.1` 正是其中之一），
重排后 **0 处**。

### ⑨.6 第三方路由不给 tool_call id —— 整条会话**从列表里消失**

**症状（比 ⑨.5 更狠：会话直接没了）**：某一轮结束后

```
format v4 tool/result at seq 19 requires toolCallId matching its tool source
tool call id requires a nonempty string
```

随后**该会话从列表里消失**（重启 App 后彻底不见），`/export` 报 HTTP 500，
**新建会话也失败**：

```
新建会话失败: gateway/internal: failed to create session "session-7d4ab1ab-…":
  SessionQueryError: stored session … is corrupt:
  SessionFormatError: tool call id requires a nonempty string
  (raw log: /data/user/0/com.dsh.android/files/home/.dsh/sessions/…/session.v4.jsonl.zstd)
```

**根因**：`dsh-llm-pi-ai` 的 `toolcall_end` 分支拿 provider 给的 id 造 tool-call 块，
**没有任何校验**：

```js
id: brandString(event.toolCall.id),   // brandString 是纯类型断言（return value），零校验
```

对比 DeepSeek 官方适配器，那里有防线
（`if (!content.id || !content.name) return malformed("empty tool identity")`）——
**pi-ai 这条路径漏了**。第三方路由（实测设备上的 `agnes` / `q`，即「模型」页里
用户自加的 provider）在流式响应里不给 `toolCall.id` 时，`id` 就是 `""` 或 `undefined`。

⚠️ **`dsh-llm` 的收口兜不住它**，两个原因叠加：

```js
id: partial.toolCallId ?? brandString(`call-${index}`),   // ① `??` 只兜 null/undefined，空串放行
if (partial.block) return partial.block;                  // ② block-end 带来的块直接短路返回
```

② 意味着 pi-ai 这种走 `block-end` 的协议**根本执行不到** ① 那一行。
所以两处都得补（`patchLlmPiAiToolCallId` + `patchLlmToolCallIdFallback`）。

⚠️ **为什么一行坏数据能搞掉整个会话**：`tool/result` 落盘后，
读取侧 `dsh-session-format-v3-to-v4` 的 `assertV4ToolResultMessage()` 要求
`toolCallId` 是非空字符串**且**等于 `source.callId`；而
`dsh-session-persistence-jsonl` 的 `consumeEventLine()` 对格式错误
**只重抛、不恢复**（只有 JSON 解析失败才走 `issue` 恢复路径），
`finish()` 还会再跑一遍 `assertReleasedV4Relationships()`。
于是**一行坏数据 ⇒ 整个会话加载失败** ⇒ 列表里消失 ⇒ 导出 500 ⇒ 新建会话被拖累。

⚠️ 空 id 能一路落盘是因为 `snapshotJsonValue()` 只校验「可无损 JSON 序列化」，
空串是合法 JSON；`undefined` 则会被 JSON 往返整个丢掉字段。两种都逃得过写入侧。

**做法**：两处补丁，兜底值用 `call-<index>` 形状（与组装器原生兜底命名一致）：

| 补丁 | 文件 | 改动 |
|---|---|---|
| `patchLlmPiAiToolCallId()` | `dsh-llm-pi-ai/lib/index.js` | `toolcall_delta` 与 `toolcall_end` 两处 `\|\|` 兜底 |
| `patchLlmToolCallIdFallback()` | `dsh-llm/lib/index.js` | `assemble()` 的 `??` 改 `\|\|`（覆盖 pi-ai 之外的 provider） |

⚠️ **只改流式事件的 id 兜底，不改持久化历史**：provider 给了真实 id 时行为完全不变。

日志：`已修正 pi-ai 的空 tool-call id: dsh-llm-pi-ai` +
`已修正 dsh-llm 组装器的空 tool-call id 兜底: dsh-llm`。
幂等：第二次启动不再打印这两行。

⚠️ **离线复现验证**（复刻 pi-ai 的 start/delta/end → 组装器 → `assertV4ToolResultMessage`）：
provider 给真 id → 通过；**给空串 → `format v4 tool/result at seq 19 requires toolCallId
matching its tool source`（与线上报错逐字一致，连 `seq 19` 都对上）**；缺 id → 同样失败。
打完补丁后三种情况全部产出非空 id。
补丁文本与官方发布件逐字匹配（各命中 1 处），替换后 `node --check` 通过。

⚠️ **已损坏的会话不会自动恢复**：本补丁只堵住新坏行的产生。已经落盘了空 id 的
历史会话仍然读不出来 —— 那种情况要么删掉该会话目录，要么另行做读取侧容错。

