# @dsh-android/bundle-android

Android 宿主的**声明式适配层**：把「能写进公开 Config」的适配收成一个 DSH bundle，
让 `EngineManager` 少一层 `--patch`、升级引擎时少一处文本锚点。

## 为什么

| 方式 | 升级引擎时 | 可审计性 |
|---|---|---|
| Kotlin 里的文本锚点（`*_GUARD`） | 可能静默失效，只打一行 warn | 差 |
| `--patch` overlay（Kotlin 每次写出） | 不受影响，但散在 60+ 个 `writeXxxPatch()` 里 | 中 |
| **bundle（本目录）** | 不受影响，且**一处声明** | 好 |

## 安装

```bash
dsh plugin --profile web add /path/to/bundle/android
```

之后每次启动都会自动叠加它的 patch。

## 收进来的（与运行期无关）

- `session-query-sqlite`：`openAt: first-search`（默认 `:memory:`；Kotlin 侧会把 path 改成 `$DSH_HOME` 落盘版，**后者覆盖前者**）
- `plugin-manager`：镜像 + 官方双源回退

## 刻意**不**收进来的（依赖运行时事实）

| 现有 overlay | 为什么留在 Kotlin |
|---|---|
| `sandbox.patch.yml` | `runnerCommand` 路径 bionic / proot 不同，且要先 stat 文件是否存在 |
| `privPatch` / `rootPatch` | 取决于设备是否授权 Shizuku / adb / root |
| `quarantine.patch.yml` | 每次启动按救援结论重写 |
| `mobile-ui` / 各工具插件 | 要先从 assets 解包到 `$DSH_HOME`，patch 里才有东西可挂 |
| `workspace.patch.yml` | `documentsDirectory` 取决于用户选的工作区 |
| `session-search.patch.yml` | 路径要绝对化（bundle 只能写死 `:memory:`） |

## 迁移表（12 个 overlay → 去向）

| # | overlay | 去向 |
|---|---|---|
| 1 | workspace | 留 Kotlin（用户工作区） |
| 2 | plugin-manager | **进 bundle** |
| 3 | sandbox | 留 Kotlin（runner 路径） |
| 4 | session-query | **进 bundle**（默认值）+ Kotlin 覆盖 path |
| 5 | mobile-ui | 留 Kotlin（assets 解包） |
| 6 | browser-pane | 留 Kotlin（client 插件，必须先落盘） |
| 7 | agnes-multimodal | 留 Kotlin（账号池文件） |
| 8 | market | 留 Kotlin（市场种子数据） |
| 9 | priv / root | 留 Kotlin（授权态） |
| 10 | tool-*（bubble/statusbar/pet/ui/logs/browser） | 留 Kotlin（assets 解包） |
| 11 | quarantine | 留 Kotlin（救援结论） |
| 12 | keyinject | 不走 overlay（并入 profile 用户层） |

## 现状

骨架已就位；`EngineManager` 仍在写同名 overlay（**后应用的层会覆盖前者**，所以两者并存不会冲突）。
真正“收口”的那一步（删掉 `writePluginManagerPatch()` 与 session-search 的重复声明）留到上机验证后做——
避免一次改两处、出问题难定位。
