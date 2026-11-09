# CHANGELOG 模板

CI 在「版本戳」步骤里把当前构建的小节**前置**到仓库根 `CHANGELOG.md`：

```sh
{ cat docs/changelog/<versionName>.md; cat CHANGELOG.md; } > CHANGELOG.new
mv CHANGELOG.new CHANGELOG.md
```

约定：

- 每个对外构建一个文件：`docs/changelog/0.4.3-debug.md`、`docs/changelog/0.5.0.md` …
- 首行必须是 `## [<versionName>] — YYYY-MM-DD`，第二行 `vc=<数字>`（`tools/version.sh --check` 依赖这两行）
- 末尾留一行 `---`，它与仓库原有内容之间才有分隔
- 小节已在 `CHANGELOG.md` 里存在时不会重复注入（幂等）
