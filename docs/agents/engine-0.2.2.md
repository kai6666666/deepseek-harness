# 引擎 0.2.1-rc.3 → 0.2.2-alpha.2 适配记录

> 目标：先证伪、再打包、后上机；任何一步失败都能退回 rc.3。
> 本文只记录**已经做过并拿到回执**的步骤，推测不写进来。

---

## 阶段 1：旁路试跑（2026-10-28）✅

### 1.1 取包与版本

```text
源码树  /storage/emulated/0/MT2/apks/deepseek harness/deepseek-harness-dsh-v0.2.2-alpha.2  192 MB
版本    package.json → "0.2.2-alpha.2"
安装    /opt/dsh022  npm i @deepseek-ai/dsh@0.2.2-alpha.2 --ignore-scripts
        registry=npmmirror，added 653 packages in 8m，node_modules 927 MB
Node    Ubuntu 侧 v24.19.0；设备 Termux 侧 v26.12.1（新要求 ≥24.9，均满足）
```

### 1.2 五个文本锚点（`tools/check-engine-anchors.mjs`）

```text
== 引擎目录: /opt/dsh022
✅ flock-platform      node_modules/@deepseek-ai/node-addon-system/lib/flock.js
✅ fail-loud-app-boot  node_modules/@deepseek-ai/dsh-app-boot/lib/index.js
✅ fail-loud-release   node_modules/@deepseek-ai/dsh/lib/profile-boot-e2mS45fC.js   ← 文件名 hash 变了，脚本按前缀扫，正常
✅ terminal-shell      node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js
✅ attachment-fsync    node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js
exit=0
```

**结论：App 侧 5 处文本补丁的锚点在 alpha.2 全部仍在，EngineManager 不需要改锚点。**

### 1.3 Ubuntu 侧冷启动

```bash
DSH_HOME=/tmp/dsh022home HOME=/tmp/dsh022home \
  node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --port 3085
```

```text
http=401        ← 服务起来了，要 token
/tmp/dsh022home/profiles/web/{cordis.yml,package.json,pnpm-workspace.yaml} 已生成
```

### 1.4 设备侧旁路启动（关键一步）

直接把 x64 的 node_modules 搬上手机是跑不起来的 —— 第一轮就撞了：

```text
Cannot find module '.../node-addon-require-builtin/build/napi/napi-v9-android-arm64/require_builtin.node'
  at tryRequireLocal (node-addon-native-custom-loader/lib/index.js)
```

npm 在 x64 上只装了 linux-x64 的可选包，android-arm64 那份没有。补四样东西后启动成功：

```text
从现网 files/engine/node_modules 复制到 files/engine022/node_modules：
  node-addon-require-builtin/build/            （android arm64 napi 产物）
  node-addon-require-builtin-android-arm64/
  @deepseek-ai/node-addon-system-android-arm64/
  node-pty/                                     （含 prebuilds/android-arm64/pty.node）
```

启动命令（与 App 同款 env，端口错开）：

```bash
cd files/engine022
HOME=$R/home DSH_HOME=$R/home/.dsh022 PREFIX=$R/termux/usr \
PATH=$R/termux/usr/bin:$PATH TMPDIR=$R/tmp022 \
  $R/termux/usr/bin/node node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --no-open --port 3086
```

回执：

```text
http=401
dsh web: http://127.0.0.1:3086/?token=aKmvsigabbShXwcYu93PBNdN4JrXiVRbfguVrI7OhNc
```

**结论：0.2.2-alpha.2 在 Android arm64 + 我们自带 Node 运行时上能起来（不含 App 的 patch 层）。**

### 1.5 阶段 1 的边界（别误读）

| 已验证 | 未验证 |
|---|---|
| 包完整性、5 个锚点、Ubuntu 冷启动、设备旁路冷启动 | 7 个插件能否 load、App 的 `--patch` 层是否兼容、UI 是否还认旧类名 |
| Node 版本门槛满足 | 0.2.2 官方新增的手机行为与我们插件的重叠面 |

旁路目录 `files/engine022/`（927 MB）先留着做阶段 3；确认不需要后整目录删。

---

## 阶段 2：App 侧补丁（待做）

锚点已 5/5 通过，理论上只需复核两处**非文本**的硬编码：

1. `requiredStartupEntryIds` —— App 侧副本，官方入口清单若变会误判“引擎没起来”；
2. `MOBILE_UI_VERSION` / `assetStamp` —— 换引擎要 bump，否则资产不重解包。

## 阶段 3：插件兼容（待做）

7 个插件逐个 load，重点看 `ctx.tools.register` 是否仍接受现有 `output` 声明、
slots（`sidebar.panellist.actions` 等）是否仍注册成功。

## 阶段 4：UI 回归（待做）

`tools/ui-regression-rc3.mjs` 六条；预期风险点：类名哈希重算、`PanelMoreMenu` 现在被
`Tooltip` 包了一层（`wide=false` 时启用）、右侧栏标签结构变化。