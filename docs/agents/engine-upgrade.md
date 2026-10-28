# 引擎升级手册（rc.N → rc.N+1）

> 目标：把 `@deepseek-ai/dsh` 换版本时，**先证伪、再打包、后上机**，任何一步失败都能退回。
> 适用范围：`engine.bin` 资产 + `MainActivity.assetStamp`。
> 最近一次执行：2026-10-28，rc.3 → **0.2.2-alpha.2**（锚点 5/5、UI 6/6、工具 7/7 注册）——
> 过程记录见 [`engine-0.2.2.md`](./engine-0.2.2.md)，操作清单见 [`engine-0.2.2-compat.md`](./engine-0.2.2-compat.md)；本文件末尾的 rc.3 数据仅作历史基线。

---

## 0. 一句话流程

```text
装目标版本到临时目录
  → 跑 tools/check-engine-anchors.mjs（5 个锚点）
  → 通过才打包 engine.bin
  → bump assetStamp
  → 上机：verify-c.sh + headless
  → 失败：回滚 assetStamp 与 engine.bin
```

---

## 1. 锚点核对（**必做，先于任何打包**）

```bash
# 装一个干净的副本（不跑安装脚本，避免本机编译原生模块）
mkdir -p /opt/dsh-rc3 && cd /opt/dsh-rc3 && npm init -y
npm i @deepseek-ai/dsh@0.2.1-rc.3 --no-audit --no-fund --ignore-scripts \
  --registry=https://registry.npmmirror.com

# 核对 5 个锚点
cd <repo>
node tools/check-engine-anchors.mjs /opt/dsh-rc3
```

### rc.3 实测结果（2026-10-26）

| 锚点 | 结果 | 文件 |
|---|---|---|
| `flock-platform` | ✅ | `node_modules/@deepseek-ai/node-addon-system/lib/flock.js:10` |
| `fail-loud-app-boot` | ✅ | `node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` |
| `fail-loud-release` | ✅ | `node_modules/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js`（文件名 hash 会变，脚本按前缀扫） |
| `terminal-shell` | ✅ | `node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js` |
| `attachment-fsync` | ✅ | `node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js` |

> ⚠️ 本轮修正了一个**路径性错误**：`flock.js` 不在包根，而在 `lib/flock.js`。
> 之前的 `AnchorAudit` 清单按包根找，会在真机上误报 `file-missing`——已同步修正 Kotlin 侧清单。

**结论**：rc.2 → rc.3 的 5 个文本锚点全部仍在，升级不需要改任何锚点常量。

---

## 2. 打包 `engine.bin`

`tools/build-engine-bin.sh` 做三件事：

1. 在临时目录 `npm i <version> --ignore-scripts`；
2. **裁剪**：删掉非 arm64 的 prebuilds、sourcemap、测试与文档（`node_modules` 原始约 859 MB，压缩前必须瘦身）；
3. `zip` 成 `engine.bin`（与 APK 内资产同名同格式）。

```bash
VER=0.2.1-rc.3 ./tools/build-engine-bin.sh
# → dist/engine.bin
```

体积实测（rc.3，本机 2026-10-26）：

| 阶段 | 大小 | 说明 |
|---|---|---|
| `npm i` 完整树 | **859 MB** | 614 包，含全平台 prebuilds |
| 裁掉非 arm64 prebuilds / sourcemap / test·docs | **698 MB** | 脚本第 2 步 |
| 压缩成 zip | **159 MB** | 直接可用，但比 rc.2 的 55 MB 大太多 |
| 再删 3 个移动端用不到的重包 | **488 MB** | `@deepseek-ai/libreoffice-kit-wasm`（146M）、`@deepseek-ai/dsh-experimental-inspector`（26M）、`sherpa-onnx-linux-arm64`（39M） |
| 压缩成 zip | **96 MB** | 当前推荐产物 |

> rc.2 的 55 MB 与 rc.3 的 96 MB 差在「依赖体积增长」，不是压缩参数。
> 若继续瘦身，可再评估 provider 依赖（`openai` 20M、`@aws-sdk`+`@smithy` 17M、`@anthropic-ai` 10M、`@opentelemetry` 18M），
> 但会牺牲对应能力——默认**不删**。
> `PRUNE_LIST` 支持自定义；路径要写**真实包名**（`libreoffice-kit-wasm` 实际在 `@deepseek-ai/` 下）。

---

## 3. 换资产与版本戳

```text
app/src/main/assets/engine.bin        ← 新包
MainActivity.assetStamp = "0.2.1-rc.3-1"
```

⚠️ **版本戳是字符串相等判据**：只换 zip 不改 stamp，启动时会命中「戳一致 ⇒ 跳过解包」，设备上静默跑回旧引擎。
（`docs/agents/asset-stamps.md` 记录过同类事故 20+ 次。）

---

## 4. 上机验收

```bash
adb logcat -d -s DSH:I | grep -E "解包|引擎就绪|assetStamp"
sh $FILES/bin/verify-c.sh            # 或设置页「运行验收」
dsh headless --json "回答两个字：收到" | tail -n 5
```

四条必须全绿：

1. `engine.log` 无 `did not activate` / `pending`；
2. `anchor-miss.json` 不存在（或为空）；
3. `verify-c.json` 的 `fail=0`；
4. 一轮真实对话能发出去（`SessionAlreadyOwnedError` 不出现）。

---

## 5. 回退

| 症状 | 动作 |
|---|---|
| 引擎起不来 / 大量 `did not activate` | 换回旧 `engine.bin` + 旧 `assetStamp`，重启 |
| 只有某个补丁失效 | 看 `anchor-miss.json` 的 tag，按提示改 `EngineManager` 常量（不要整包回滚） |
| 插件全挂但引擎正常 | 先跑救援模式（L2）确认是不是第三方插件 |
| 会话写不进去 | 查 flock：`node -e "require('@deepseek-ai/node-addon-system/flock')"` |

---

## 6. rc.3 之后还要关注的新东西

- `packages/session-query-sqlite` 仍用 `node:sqlite`，`openAt` 语义未变（我们的 overlay 继续有效）；
- `packages/sandbox/sandbox-local` 的 `runnerCommand` 契约未变；
- `web-app` bundle 里 `tool-bash` 的 win32 判定未变。

升级 rc.4 时重跑第 1 节即可；若某个锚点缺失，脚本会打印**候选行**（含关键 token 的 3 行），照着改常量。 

---

## 7. 与 CI 的关系

- `engine-compile` job 只保证 Kotlin 侧能编；
- 锚点核对建议也接进 CI（装 rc.N 再跑 `check-engine-anchors.mjs`），成本约 3 分钟；
- 打包与上机只能手动，因为资产（~135 MB）不入库。