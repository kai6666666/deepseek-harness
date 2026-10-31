# 失败现场归档

`tools/archive_fail.py <版本>` 会把一次不合格的取证现场推到本目录：

- `verify-<版本>-<时间戳>.json`：`mp-verify.cjs` 的原始输出（含 `stages` / `retries` / `attempt` / `ms`）
- `verify-<版本>-<时间戳>-ui.png`：失败瞬间的整屏截图（设备侧 `dsh-<版本>-fail.png`）

归档只在「两轮取证都不合格」时发生；合格记录进 `../mobile-ui-verification.md`，不进本目录。
