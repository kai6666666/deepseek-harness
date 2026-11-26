# 交接文档 — DSH for Android（维护态）

> 生成时间：2026-11-26 23:5x（本地）
> 用途：新会话接手时，读这一份即可继续实施 `docs/plan/pa-pb-plan.md`。
> 上一份计划文档：`docs/plan/pa-pb-plan.md`（A+B 权威计划，518 行）
> 进度账本：`docs/plan/progress.md`（33,136 B，§4.16 起为本轮结案记录）

---

## 1. 项目定盘星（不要改）

| 项 | 值 |
|---|---|
| `applicationId` | `com.dsh.android`（0.4.1 起固定，**不再变更**） |
| `targetSdk` | 35 |
| 架构 | **单宿主 PRoot + glibc 单运行时**（rootfs 内 `/usr/bin/node`、`/opt/dsh`） |
| GUI | WebView 加载官方 Web GUI（`dsh web`，`127.0.0.1`） |
| `DSH_HOME` | `files/home/.dsh` |
| 工作模式 | **维护态：只修 bug，不改身份与架构** |
| 参照实现 | `Operit-main` |

**硬约束**：不做多运行时，不做 musl，不改包名，不改 `DSH_HOME`。

---

## 2. 环境与路径地图

### 构建机（Linux / PRoot Ubuntu 24）

```text
/root/dsh-work/repo                    仓库（远端 kai6666666/deepseek-harness）
/root/dsh-work/v113                    发版/重签/下载脚本与临时 python 工具
/tmp/gh_token                          classic token（scopes=repo,workflow，**logs 401**）
/tmp/gh_token2                         fine-grained token（**当前唯一可用**，logs 仍 401）
```

> ⚠️ **token 陷阱**：换 token 后旧脚本仍读 `/tmp/gh_token`。凡新写的脚本统一读 `/tmp/gh_token2`。

### 设备（root 侧 / Shizuku shell）

```text
包名                      com.dsh.android
运行时根                  /data/user/0/com.dsh.android/files/runtime/rootfs
node                      files/runtime/rootfs/usr/bin/node（需 PRoot 环境，宿主直接跑会 No such file）
dsh 安装                  files/runtime/rootfs/opt/dsh
GUI 预构建前端            files/runtime/rootfs/opt/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist
  · assets/index-Ciz7DZxv.js      （Menu/anchor-name 逻辑）
  · assets/index-CSAdOBx6.css     （.portal 的 CSS Anchor 定位）
插件（official）          .../node_modules/@deepseek-ai/dsh-client-ui-*
自建 market 插件          files/home/.dsh/market/dsh-android-market/（index.js + client.js + seed.json）
profile 配置              files/home/.dsh/profiles/web/cordis.patch.yml（**用户配置层，76 行**）
命令行 overlay（App 生成） files/home/.dsh/market.patch.yml（**每次启动整体重写**）
日志                      files/logs/app.log
```

---

## 3. 当前版本状态

```text
tools/app-version.txt     versionName=0.2.2-rc.5-debug.46
                          versionCode=131
最新提交                  2ab50e7  release: debug.46 (vc131)
CI 构建                   run 45851754753  → completed success
产物（Actions artifact）  dsh-system-debug    165,775,412 B
                          dsh-system-release  165,760,574 B
                          runtime-arm64-v8a   150,861,686 B
Release（公开下载）        **未发布**（step 29 skipped；需 dispatch publish-apk.yml）
设备已装版本              debug.45 / vc130（功能完好，**未升级到 46**）
```

### 发版怎么发（照抄）

```bash
# 1. 改版本
cd /root/dsh-work/repo
#   tools/app-version.txt → versionName / versionCode 各 +1 一路
#   CHANGELOG.md 在「上一个正式版标题」之前插入新段，格式：
#     ## [0.2.2-rc.5-debug.NN] — YYYY-MM-DD
#     vc=NNN
#     ### …
# 2. 自检（必须看到 VERSION PASS）
sh tools/version.sh --check
# 3. 推送
git add -A && git commit -m 'release: debug.NN (vcNNN) —— …' && git push origin main
# 4. **push 不会触发 APK 构建**，必须 dispatch
#    workflow: apk.yml（id 396940173）「构建 APK（x86_64 runner）」
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/kai6666666/deepseek-harness/actions/workflows/396940173/dispatches \
  -d '{"ref":"main"}'
# 5. 公开 Release（可选）
#    workflow: publish-apk.yml（id 421733743）
```

**workflow 清单**：`apk.yml`(396940173) / `apk-x64.yml`(416103724) / `ci.yml`(395267315 仓库卫生，push 自动触发) / `compile.yml`(416013326) / `runtime.yml`(415938592) / `publish-apk.yml`(421733743) / `sign-upgrade-apk.yml`(422137521)

---

## 4. 未完成：B 阶段（启动耗时三段测量）—— **下一步就做这个**

### 已有实测（`debug.44 / vc129`，4 次冷启）

```text
nodeExec    49,647 / 46,750 / 43,224 / 63,964 ms     跨度 20.7 s，1.48 倍波动
preflight    1,720 /  1,835 /  1,607 /  1,039 ms     稳定
注入后       39,094 / 44,090 / 51,351 / 100,781 ms   （含 force-stop 冷启）
```

**推论**：`preflight` 是少量小文件 stat/read，稳定；`nodeExec` 是大量顺序小文件读取，波动 ⇒
瓶颈是**页缓存命中率**，不是 CPU、也不是固定装载开销。

### 待实施的三层方案（按此顺序，每步独立可回滚）

**第 1 层：guest 侧时间戳 wrapper（首选，纯新增文件）**

- 目标：把 `nodeExec` 拆成「PRoot 装载 / node 引导 / 模块解析 / 首响应」四段。
- 做法：在 `rootfs` 内写一个 `-r` 预加载脚本，用 `Date.now()` 打点（**不要用 `date +%s%3N`**，
  宿主机直接执行 `./usr/bin/date` 会 `No such file or directory`，因为没有 PRoot 环境与动态链接器）。
- 在 `EngineManager.buildCommand()` 的 argv 里，`node` 与入口之间插 `-r <preload>`。
- 打点走 `process.stderr.write`，同时写一行到 `files/logs/app.log` 同源文件，便于与宿主 `boot.timeline` 对齐。
- ⚠️ **不要动 `buildCommand` 的既有形参**（见 §6 教训）。

**第 2 层：`/proc/<pid>/io` 采样**

- 在 `node` 进程启动后按 200 ms 间隔读 `rchar` / `read_bytes`，画「字节累积 vs 时间」曲线。
- 判定：若 `read_bytes` 增长接近 0 而 `rchar` 大量增长 ⇒ 全命中页缓存；反之需要预读。

**第 3 层：对照实验**

- 同一 APK 连续 3 次冷启（`am force-stop` + 启动）vs 热启 1 次。
- 若冷启差距线性于「首次读盘量」，则「预热 rootfs」是可优化方向（例如启动时 `posix_fadvise` 或顺序全部 touch 一遍）。

### 交付物

```text
docs/plan/progress.md 新增 §4.18「B 阶段三段测量：数据与结论」
三段瀑布图（文本表格即可）+ 优化建议（预热 or 预读）
```

---

## 5. 已知问题（接手后不要重复踩）

### 5.1 插件页 `∨` 弹窗一闪 / 塌陷 —— **已跳过，官方缺陷**

- 现象：「发现」「插件市场」两个 Tab 的右上角 `∨` 菜单点开后一闪而过。
- 根因（`dsh-client-ui-primitives` 的 `Menu`）：
  - `.portal` 整段定位依赖 `anchor()`；`anchor-name` 由 `useLayoutEffect` 写入；
  - `listClassName`（宽度 320px / 行高 72px）**只在 portal 分支应用**。
  - ⇒ `portal:true` 会闪，`portal:false` 不闪但塌陷，两者互锁。
- **已完整回滚**到官方原样。**装插件请用同页 `+` 按钮**（打开 InstallDialog，一直正常）。
- 六次尝试对照与代码级依据见 `docs/plan/progress.md` §4.16。
- 正解：升级 `@deepseek-ai/dsh-client-ui-primitives` / dsh 版本，或 fork `Menu.tsx`。

### 5.2 `plugin-market` 判据（此前记错过，已更正）

- ❌ 旧记法：「id 出现在任何 `*.patch.yml` 就会让 `settings.update` 被拒」。
- ✅ 正确：**只针对命令行 overlay**，即 App 每次启动重写的 `market.patch.yml`。
  写入 `profiles/web/cordis.patch.yml`（用户配置层）是正常且必需的。
- 侧记：`market.patch.yml` 里若出现 `- id: plugin-market`，错误是
  `{"code":"gateway/internal","message":"Configuration for \"plugin-market\" is overridden by a home patch or command-line overlay"}`。

### 5.3 设备侧补丁的持久性

- 本轮为修弹窗在设备上改过 `plugin-manager/lib/client.js` 与 dist CSS，**均已回滚原样**。
- `profiles/web/cordis.patch.yml` 的 `indexes` 里**保留了 fastly 备用镜像**（这一条是②的修复，必须保留）：
  ```yaml
  - id: plugin-market
    name: "@deepseek-ai/dsh-plugin-market"
    config:
      indexes:
        - https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
        - https://fastly.jsdelivr.net/npm/dsh-plugin-catalog/index.json
  ```
  备份：`cordis.patch.yml.bak3`。
- ⚠️ **rootfs 更新会覆盖任何 rootfs 内的手改**。要长期生效必须做成启动自检（改 App 代码并发版），
  像 `writeMarketPatch()` 那样每次启动校验/重写。

### 5.4 `indexes` 为空时「发现」Tab 消失（未修，已知设计缺陷）

用户会失去添加入口。当前配置剩 jsdelivr + fastly 两条，不触发。

---

## 6. 诊断手段与坑（这一节最值钱）

### 6.1 可用的 CI 诊断通道

| 手段 | 可用 | 条件 |
|---|---|---|
| `/repos/{R}/check-runs?ref=<sha>` | ✅ | **必须用 commit sha**，用分支名会 404 |
| `/check-runs/{id}/annotations` | ✅ | 任意 token；配合 workflow 内 `echo "::error title=X::内容"` |
| `/actions/artifacts/{id}/zip` | ✅ | **必须禁用重定向**取 302 的 `Location`，再**不带 Authorization** 请求（S3 预签名） |
| `/actions/jobs/{id}/logs` | ❌ 401 | classic（repo,workflow）与 fine-grained 均失败 |
| WebView CDP | ❌ | `@webview_devtools_remote_<pid>` 存在，但跨 uid（u0_a232→u0_a643）被 SELinux 拒 |

**artifact 下载的正确写法**（已验证）：

```python
class NoRedir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
op = urllib.request.build_opener(NoRedir)
req = urllib.request.Request(
    'https://api.github.com/repos/%s/actions/artifacts/%d/zip' % (R, A),
    headers={'Authorization': 'Bearer ' + T, 'User-Agent': 'x'})
try: op.open(req, timeout=60)
except urllib.error.HTTPError as e:
    loc = e.headers.get('Location')
    data = urllib.request.urlopen(urllib.request.Request(loc), timeout=120).read()
```

> 单测报告 zip 里**没有 XML**，只有 `classes/<Class>.html`；失败堆栈要从 HTML 正则提取。

### 6.2 设备侧诊断

| 手段 | 用法 |
|---|---|
| `app.log` | `boot.timeline total=` / `engine.ready ms=` / 插件相关都在这里 |
| 可见 CSS 探针 | 在样式里加 `outline:2px solid red`，主人一眼判断「补丁是否被加载」 |
| 偏移定位 + `dd` | `grep -bo <pattern>` 取字节偏移，`dd if=$F bs=1 skip=N count=M` 切片或写入 |
| `grep -o "<rule>{[^}]*}"` | 从压缩 bundle 里直接抠出整条 CSS 规则 |

### 6.3 环境陷阱（逐条踩过）

1. **`run-as` 读不到 `/sdcard`**（scoped storage）。反向可行：`run-as ... cat f` 输出到宿主。
   但 `run-as ... cat f > /sdcard/x` 会得到 **0 字节**。
2. **`rm -rf` 被工具拦为危险命令**。改用 `mv Cache Cache.old1` 之类。
3. Android `grep` **不支持 `.\{300\}`**（`invalid repetition count(s)`）。用 `grep -bo` + `dd`。
4. **引号层级过深**（shell→adb→run-as→awk）会 `sh: syntax error: unexpected '('`。降一层或写脚本文件。
5. **`run-as` 内 `cp` 到 `/sdcard` 报 Permission denied**，只能 stdout 重定向。
6. **GitHub `contents` API 拉大文件会 `IncompleteRead`**，改用 `raw.githubusercontent.com`。
7. **偏移顺序陷阱**：先插入内容（在 210k）再按旧偏移改 274k，会**破坏原文**。
   **正确顺序：先按原偏移改，后插入**。
8. **等长替换优先**：如 `portal:true`(11B) → `portal:!1␠␠`(11B)、`phase===\`idle\``(14B) → `phase!==\`busy\``(14B)，
   可保文件大小不变、后续偏移全部不动。
9. **`writeTimingPreload` 正则删函数时要排除函数体那一行**——`db0a56b85b` 就是这么把
   `symlink()` 写成自己调自己、连红五轮的。

---

## 7. 提交历史（本轮，供追溯）

```text
2ab50e7   release: debug.46 (vc131)
9201a5cf9 docs(progress): 4.16 结案——弹窗定为官方 Menu 缺陷，回滚并跳过；新增 4.16.1 诊断表
48db2c60d docs(progress): 4.15~4.17 symlink 自递归 / 弹层双条件门 / artifact 302 通道
36897ba85 fix(test): symlink 帮助函数自我递归导致 StackOverflowError
be2f77eb0 ci: ::error:: 诊断 + if-no-files-found: warn
db0a56b85 test: 符号链接加固（**引入了自递归 bug**）
f400211bd revert timing（**没干净**，残留 19 行裸 JS，后由 4a6b1fdc 覆盖修复）
4a6b1fdc fix: EngineManager 恢复到 debug.45 基线
2dca5cc07 debug.45 基线
```

**CI run 关键记录**

```text
45851754753  2ab50e752c  构建 APK（x86_64 runner）  success   ← debug.46
45806006760  36897ba851  构建 APK（x86_64 runner）  success   ← symlink 修复验证
45646392863  （debug.45）                           success
45654974791  publish-from-run 重跑                   success   9 资产
45648358602  publish-from-run（空壳 Release）          failure   assets=0
```

---

## 8. 接手后的动作清单（按优先级）

1. **确认基线**：`git log --oneline -1` 应为 `2ab50e7`；`sh tools/version.sh --check` 应出 `VERSION PASS`。
2. **B 阶段第 1 层**：写 guest 侧 `Date.now()` 预加载脚本 + argv 插 `-r`（纯新增，不动 `buildCommand` 形参）。
3. 冷启 3 次 + 热启 1 次，采集三段数据，写进 `progress.md` §4.18。
4. 视结果做第 2 层（`/proc/<pid>/io`）或直接给预热建议。
5. 如需公开下载：dispatch `publish-apk.yml` 发 `debug.46` Release。
6. 设备升级到 `debug.46` 后复测启动数据（当前设备仍为 `debug.45/vc130`）。

---

## 9. 与主人协作的方式

- 主人给**极简编号指令**（①②③）→ 先给**理解**待确认 → 执行 → 汇报。
- 汇报格式固定：**首行短标题**（方案/步骤/原理/代码）→ 分点 → 代码块 → 验证方法。
- 每轮结尾给**下一步动作**，不要问「要不要继续」。
- 主人要求「检查代码，更新文档」时，要真的跑 `git status` / `grep` 验证，不要凭记忆写。
- 真机验证必须由主人点击确认，不要替他断言「应该好了」。
