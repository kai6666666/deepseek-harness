# 引擎升级手册（rc.N → rc.N+1）

> 目标：换 `@deepseek-ai/dsh` 版本时，**先证伪、再打包、后上机**，每一步都能退。
> 最近执行：2026-10-26，rc.2 → **rc.3**（锚点 5/5 通过）。

---

## 0. 流程

```text
装目标版本到临时目录 → tools/check-engine-anchors.mjs（5 个锚点）
  → 通过才打包 engine.bin → bump assetStamp
  → 上机：verify-c.sh + headless → 失败回滚
```

---

## 1. 锚点核对（必做）

```bash
mkdir -p /opt/dsh-rc3 && cd /opt/dsh-rc3 && npm init -y
npm i @deepseek-ai/dsh@0.2.1-rc.3 --no-audit --no-fund --ignore-scripts \
  --registry=https://registry.npmmirror.com
cd <repo> && node tools/check-engine-anchors.mjs /opt/dsh-rc3
```

### rc.3 实测（2026-10-26）

| 锚点 | 结果 | 文件 |
|---|---|---|
| `flock-platform` | ✅ | `@deepseek-ai/node-addon-system/lib/flock.js:10` |
| `fail-loud-app-boot` | ✅ | `@deepseek-ai/dsh-app-boot/lib/index.js` |
| `fail-loud-release` | ✅ | `@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js`（hash 会变，脚本按前缀扫） |
| `terminal-shell` | ✅ | `@deepseek-ai/dsh-terminal-bash/lib/index.js` |
| `attachment-fsync` | ✅ | `@deepseek-ai/dsh-attachment-local/lib/index.js` |

> ⚠️ 本轮修了一个**路径性错误**：`flock.js` 在 `lib/flock.js`，不在包根。
> 旧的 `AnchorAudit` 清单按包根找，会在真机上误报 `file-missing`——Kotlin 侧已同步修正。

**结论：rc.2 → rc.3 的 5 个锚点全部仍在，升级不需要改任何锚点常量。**

---

## 2. 打包 engine.bin

```bash
VER=0.2.1-rc.3 ./tools/build-engine-bin.sh     # → dist/engine.bin
```

### 体积实测（rc.3）

| 阶段 | 大小 | 说明 |
|---|---|---|
| `npm i` 完整树 | **859 MB** | 614 包，含全平台 prebuilds |
| 裁非 arm64 prebuilds / map / test·docs | **698 MB** | 脚本第 2 步 |
| zip | **159 MB** | 直接可用，但远大于 rc.2 的 55 MB |
| 再删 3 个移动端用不到的重包 | **488 MB** | `@deepseek-ai/libreoffice-kit-wasm` 146M、`@deepseek-ai/dsh-experimental-inspector` 26M、`sherpa-onnx-linux-arm64` 39M |
| zip | **96 MB** | 当前推荐产物 |

> rc.2 55 MB → rc.3 96 MB 是依赖体积增长，不是压缩参数。
> 仍可继续瘦身（`openai` 20M、`@aws-sdk`+`@smithy` 17M、`@anthropic-ai` 10M、`@opentelemetry` 18M），但会牺牲对应能力，默认不删。
> `PRUNE_LIST` 可自定义；路径写真实包名（scoped 要带 `@deepseek-ai/`）。

---

## 3. 换资产与版本戳

```text
app/src/main/assets/engine.bin    ← 新包
MainActivity.assetStamp = "0.2.1-rc.3-1"
```

⚠️ 版本戳是**字符串相等**判据：只换 zip 不改 stamp，会命中「戳一致 ⇒ 跳过解包」，静默跑回旧引擎。

---

## 4. 上机验收

```bash
adb logcat -d -s DSH:I | grep -E "解包|引擎就绪|assetStamp"
sh $FILES/bin/verify-c.sh
dsh headless --json "回答两个字：收到" | tail -n 5
```

四条全绿才算过：

1. `engine.log` 无 `did not activate` / `pending`；
2. `anchor-miss.json` 不存在（或为空）；
3. `verify-c.json` 的 `fail=0`；
4. 一轮真实对话能发出去，且无 `SessionAlreadyOwnedError`。

---

## 5. 回退

| 症状 | 动作 |
|---|---|
| 引擎起不来 / 大量 `did not activate` | 换回旧 `engine.bin` + 旧 `assetStamp` |
| 只有某个补丁失效 | 看 `anchor-miss.json` 的 tag，按提示改常量（不要整包回滚） |
| 插件全挂但引擎正常 | 先跑救援模式（L2） |
| 会话写不进去 | 查 flock：`node -e "require('@deepseek-ai/node-addon-system/flock')"` |

---

## 6. rc.3 之后的关注点

- `session-query-sqlite` 仍用 `node:sqlite`，`openAt` 语义未变（overlay 继续有效）；
- `sandbox-local` 的 `runnerCommand` 契约未变；
- `web-app` 里 `tool-bash` 的 win32 判定未变。

升级 rc.4 重跑第 1 节；锚点缺失时脚本会打印**候选行**，照着改常量。

---

## 7. CI

- `engine-compile` 只保证 Kotlin 能编；
- 建议再加一个 job：装 rc.N → 跑 `check-engine-anchors.mjs`（约 3 分钟）；
- 打包与上机只能手动（资产不入库）。
