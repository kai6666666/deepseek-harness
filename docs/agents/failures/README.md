# 失败现场归档

`tools/archive_fail.py <版本>` 在两轮取证都不合格后归档现场：证据 JSON（`stages` / `retries` / `attempt` / `ms`）与失败瞬间整屏截图。
合格记录进 `../mobile-ui-verification.md`，本目录只收失败。

## 归档索引

| 时间 | 版本 | 轮次 | 失败原因 | 证据 |
|---|---|---|---|---|
| 2026-10-31 17:58 | 1.1.0-146 | — | 环境漂移:1项（meta.client = 本地 client） | [json](drift-1.1.0-146-20261031-175816.json) |
