# 移动端 UI 插件 · 发布流水线

一条命令从改完代码走到「验收表新增一行」。本文件是工具链总说明；逐次发布的实测记录在
[`mobile-ui-verification.md`](mobile-ui-verification.md)，失败与异常证据在 [`failures/`](failures/README.md)。

## 一、五步链

```text
bash tools/ship.sh [版本号] [--wait] [--strict] [--fix-drift] [--no-drift] ...
```

| 步 | 动作 | 产出 | 失败退出码 |
|---|---|---|---|
| 1/5 | 出包 + 下载 + 校验（`push.sh` → `release.py`） | `dsh-ci-<ver>.apk`、`verify-<ver>.meta.json`、`install-<ver>.sh`、`verify-<ver>.sh` | 1 |
| 1.5/5 | 拍九项基线快照 | `verify-<ver>.baseline.json` | — （不阻断） |
| 2/5 | 装机 + 取证（等设备侧脚本，可 `--wait`） | `verify-<ver>.json`、`.sum`、`-ui.png` | 2（超时） |
| 3/5 | 判定（`clicked` / `match` / `msgs==0` / 菜单 7 行 / 各阶段 ok） | 不合格则留 `-fail.png` 并归档 | 3 |
| 4/5 | 登记表推送（`record.py`，17 列） | `docs/agents/mobile-ui-verification.md` | 1 |
| 5/5 | 一致性体检（`drift_check.py --save --diff`） | `verify-<ver>.drift.json`、`.diff.json` | 4（漂移）/ 5（strict 扰动） |

无参数时自动读远端 `MOBILE_UI_VERSION` 并 +1：

```bash
bash tools/ship.sh --wait --strict          # 1.1.0-146 → 1.1.0-147
python3 tools/release.py --bump-only        # 只查询下一个版本号
```

## 二、退出码

| 码 | 含义 | 表内结果 | 归档 |
|---|---|---|---|
| 0 | 九项一致，过程干净 | `0/9 · ✅` | 无 |
| 2 | 等不到设备侧取证结果 | 不登记 | 无 |
| 3 | 取证不合格 | 不登记 | `failures/verify-*.json[/png]` |
| 4 | 九项漂移 | `🚩N · 🚩` | `failures/drift-*.json`（+ change） |
| 5 | 九项一致但过程有扰动（`--strict`） | `0/9·… · ⚠` | `failures/perturb-*.json` |

## 三、选项

| 选项 | 作用 |
|---|---|
| `--wait` | 无 adb 时等设备侧 `verify-<ver>.json` 出现（`--timeout=N` 控制，默认 900s） |
| `--skip-build` | 不重新出包，只重生装机/取证脚本 |
| `--verify-only` | 只取证（隐含 `--skip-build`），约 20s 刷新一行 |
| `--pause-on-fail` | 不合格时保留 `verify-<ver>-fail-<时间戳>.json` |
| `--no-drift` | 跳过 5/5 |
| `--fix-drift` | 5/5 先自愈（meta 体积 / client 字节 / 表内 client）再判定 |
| `--strict` | `wait + changes + fixed > 0` 即 exit 5，并归档扰动汇总 |

## 四、验收表 17 列

| # | 列 | 来源 |
|---|---|---|
| 1 | 版本 | `ship.sh` 的版本号 |
| 2 | 设备戳 | 设备文件 `.mobile_ui_version` |
| 3 | CI run | GitHub Actions run id |
| 4 | APK | APK 体积（MB） |
| 5 | client | `client.js` 字节数 |
| 6 | dex 戳 | 版本常量在 dex 中命中次数（`2/2`） |
| 7 | 七行菜单 | 菜单项是否与期望 7 项完全一致 |
| 8 | 创造模式 | 会话模式 |
| 9 | 文案一致 | 输入框文案是否匹配 |
| 10 | 消息数 | 应为 0 |
| 11 | 轮次 | 第几轮取证才通过（1 = 首轮） |
| 12 | 重试 | `r0` 或 `r0 ×2` |
| 13 | 耗时 | 取证总毫秒折算秒 |
| 14 | 截图 | `dsh-<ver>-ui.png` |
| 15 | 记录时间 | 登记时刻 |
| 16 | 漂移 | `0/9` / `🚩N`，后缀 `·fixK·chgN·waitN` |
| 17 | 状态 | `✅` / `⚠` / `🚩` / `—` |

漂移列后缀语义：

```text
·fixK   自愈了 K 项（meta 体积、client 字节类可重算项）
·chgN   发布前后快照净差异 N 项（--baseline 与 5/5 对比）
·waitN  等待设备取证期间环境被改过 N 次（15s 巡检抓到）
```

状态判定：`drift>0 → 🚩`；否则 `wait+changes+fix>0 → ⚠`；否则 `✅`；无报告 `—`。
旧表自动迁移：8 / 10 / 12 / 14 / 15 / 16 列都会补齐到 17 列，迁移不丢行、按版本降序。

## 五、五个归档通道

全部落在 `docs/agents/failures/`，索引在同一目录 `README.md`，按时间降序、同版本覆盖。

| 通道 | 命令 | 触发 | 文件 |
|---|---|---|---|
| 不合格现场 | `archive_fail.py <ver>` | 3/5 判定失败 | `verify-<ver>-<ts>.json` + `-ui.png` |
| 环境漂移 | `archive_fail.py --drift <ver>` | 5/5 漂移（exit 4） | `drift-<ver>-<ts>.json` |
| 等待期日志 | `archive_fail.py --log <ver> --file <log> --count N` | 等待期有状态变化 | `watch-<ver>-<ts>.log` |
| 变更清单 | `archive_fail.py --change <ver>` | `changes>0` | `change-<ver>-<ts>.json` |
| 扰动汇总 | `archive_fail.py --perturb <ver>` | `--strict` 触发（exit 5） | `perturb-<ver>-<ts>.json` |

## 六、一致性体检

```bash
python3 tools/drift_check.py                 # 九项体检，漂移 exit 1
python3 tools/drift_check.py --json          # 机器可读
python3 tools/drift_check.py --save 1.1.0-146    # 写 drift.json（表内漂移列数据源）
python3 tools/drift_check.py --fix           # 自愈可重算项
python3 tools/drift_check.py --baseline      # 拍快照
python3 tools/drift_check.py --diff          # 与快照比对，输出变更清单
python3 tools/drift_check.py --watch 30      # 常驻巡检，绿转红即刻归档
```

九项：远端版本 = 表内版本、表内设备戳 = 版本、远端 client = 本地、表内 client = 本地、
meta.client = 本地、meta.dex 命中 = 2、设备取证戳 = 版本、APK 体积 = meta、轮次已记录。

## 七、设备侧约定

- 装机必须 `cp apk /data/local/tmp/` 后 `pm install -r`（`/sdcard` 受 SELinux `fuse` 限制会被拒）。
- 取证结果从 `run-as <app> cat files/…` 拉到 `/data/local/tmp` 再 `cp` 到 `/sdcard/Download`（直接重定向会得到 0 字节）。
- 取证脚本内两轮：首轮 `MP_RETRY`，第二轮先 `am force-stop`/`am start` 并 `MP_RETRY+2`；两轮都失败才写 fail 快照。
- 本机没有 `adb` 设备时一律走 `--wait`，由人在设备上执行 `sh /sdcard/Download/install-<ver>.sh`。

## 八、常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 基线快照记成「已坏」值，diff 报无变化 | 1.5/5 采集期间环境就被改动；等基线行落盘后再动手 |
| 巡检没抓到变化 | 篡改发生在基线采集之前，或两次采样之间已复原 |
| `NameError: ${MP_RETRY}` | 装机脚本模板里要写 `${{MP_RETRY:-0}}` |
| 表内 client 与本地不一致 | `drift_check.py --fix` 或重跑 `record.py` |
| failures 索引残留演练行 | 删除对应文件后按需要清掉索引行，README 只留表头 |

## 九、仓库文件

```text
tools/release.py        出包、下载、校验、装机/取证脚本生成、双轮重试
tools/ship.sh           五步链、等待期巡检、strict、归档调度
tools/record.py         17 列表格、旧表迁移、版本降序、同版替换
tools/archive_fail.py   五个归档通道 + 索引维护
tools/drift_check.py    九项体检、自愈、快照、diff、巡检
tools/trend.py          从验收表生成 trend.md（APK/耗时趋势与差值）
tools/push.sh           薄壳：exec python3 tools/release.py "$@"
files/mp-verify.cjs     一次连 CDP 跑完四段取证，输出结构化 JSON
```