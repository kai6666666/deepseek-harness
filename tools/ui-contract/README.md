# UI 契约层（进行中）

## 为什么

官方前端是 webpack 产物，类名形如 `.aB3dE_root`（内容哈希 + 语义后缀）。我们自己的
`client.js` / Kotlin 注入代码直接引用这些哈希名——官方一次重编译就全断，且**不会有编译错误**，
只会在真机上表现为「某块 UI 不生效」。

## 现在有什么

`audit.mjs`：扫 `app/src/main` 与 `mobile-ui-plugin`，统计哈希类名的唯一数量与分布，
并支持 CI 门禁：

```bash
node tools/ui-contract/audit.mjs                 # 人读
node tools/ui-contract/audit.mjs --json          # 机器读
node tools/ui-contract/audit.mjs --write-baseline
node tools/ui-contract/audit.mjs --max 159       # 超过即 exit 1
```

当前基线：**159 个唯一类名 / 43 个文件**（`baseline.json`）。门禁先锁在 159：
**只许减，不许增**。

## 迁移方向（三级选择器）

1. `data-*`：官方已有 `data-conversation-header-leading` / `data-sidebar-*` / `data-mobile`，优先用；
2. ARIA：`role=` / `aria-label=` / `aria-modal` 等语义属性；
3. contract：`tools/ui-contract/contract.json` 保存 `hash → 语义名` 映射，注入时查表。

三级都拿不到时**不注入**（而不是猜一个选择器），并把 miss 写进 `web.log`。

## 下一步

- `extract.mjs`：从官方 dist 生成候选映射（class 出现位置 + 相邻属性），人工确认后写入 contract；
- 按文件迁移，从 `client.js`（60 个，最多）开始；每迁一个文件，把 `--max` 下调；
- CI 加 `audit --max <当前基线>`，任何新增立即红。
