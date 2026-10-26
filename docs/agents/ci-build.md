# CI 构建 APK（A 方案）

## 1. 为什么必须是 x86_64 runner

本机（arm64）实测：`./gradlew :app:assembleSystemDebug` 能配置工程、能解析 AGP，
停在工具链：

```text
Failed to install … build-tools;35.0.0
```

因为 Google 的 build-tools 只发 **linux-x86_64** 二进制（`aapt2` / `d8` / `zipalign` /
`apksigner`）。Debian 的 `android-sdk-build-tools` 只提供 `aapt` 与 `aapt2`（arm64），
没有 dex 与打包工具。

所以：**本机只做编译门禁（`tools/verify-engine.sh`），出包交给 `ubuntu-latest`。**

## 2. 工作流

文件：`.github/workflows/apk.yml`

| 步骤 | 作用 |
|---|---|
| `setup-java` 17 temurin | AGP 8.x 要求 JDK 17 |
| `android-actions/setup-android@v3` | 装 `platforms;android-35` + `build-tools;35.0.0` |
| `tools/ci-fetch-assets.sh` | 从 Release 下载 `dsh-assets*.zip` 铺到 `app/src/main/assets/` |
| `tools/verify-engine.sh` | engine 包独立编译门禁（不需要资产，先失败先报） |
| `./gradlew :app:assembleSystemDebug` | 出包 |
| `upload-artifact` | `dsh-system-debug`（APK + metadata，保留 14 天） |

触发：`push`（`app/**`、`*.gradle.kts`、`bundle/**`、工作流自身）、`pull_request`、手动 `workflow_dispatch`。

## 3. 资产怎么准备（一次性）

资产共 28 项、约 135 MB，**不入库**。做法：打成一个 Release 附件。

```bash
# 在出过包的机器上（本机也行，assets 目录里已有真实文件）
cd app/src/main/assets
zip -9 -r /tmp/dsh-assets.zip . -x '*.md'

# 建 Release 并上传（gh 已登录，或 GH_TOKEN=…）
gh release create assets-v1 /tmp/dsh-assets.zip \
  --title "构建资产 v1" \
  --notes "engine.bin / node-runtime.bin / 原生 zip；供 CI 构建 APK 使用"
```

然后在仓库 **Settings → Variables** 加：

```text
ASSETS_RELEASE = assets-v1
```

没有这个变量也能跑：工作流会打印 `::notice::未指定 ASSETS_TAG`，出一个**无引擎 APK**
（能装、能开界面，启动引擎时提示缺资产）。

## 4. 手动触发与严格模式

`Actions → 构建 APK → Run workflow`：

| 输入 | 含义 |
|---|---|
| `assets_release` | 覆盖仓库变量，填 `assets-v1`；留空则读 `vars.ASSETS_RELEASE` |
| `strict_assets` | `1` = 缺任何一项资产直接失败（发布前用）；`0` = 降级出包 |

## 5. 产物与安装

```text
app/build/outputs/apk/system/debug/app-system-debug.apk   # flavor=system（WebView）
```

- 只出 `system` flavor；`gecko`（GeckoView）依赖预编译 AAR，需要另配仓库，暂不进 CI。
- `debug` 签名由 AGP 自动生成（`~/.android/debug.keystore`），**不能用于分发**；
  正式包走本地 `keystore.properties` + `assembleSystemRelease`。
- 装机注意：`targetSdk = 28`、`applicationId` 恰好 15 字符（`com.dsh.android`）——
  这两个是 Termux ELF 改写与 `execve` 限制决定的，不能改。

## 6. 失败排查表

| 症状 | 原因 | 处理 |
|---|---|---|
| `Failed to install build-tools;35.0.0` | SDK 许可未接受 | `setup-android` 的 `log-accepted-android-sdk-licenses: true` 已开；自建 runner 需手跑 `sdkmanager --licenses` |
| `Unresolved reference: R` | `android.jar` 与 compileSdk 不匹配 | 确认装了 `platforms;android-35` |
| 构建 OOM | Gradle daemon 默认堆偏小 | 在 `gradle.properties` 调 `org.gradle.jvmargs=-Xmx3g` |
| 资产步骤 404 | Release tag 写错 / 附件名不是 `dsh-assets*.zip` | 检查 tag 与附件命名 |
| APK 装完引擎起不来 | 走的无资产模式 | 看 `assets/ASSETS_MISSING.txt` 与服务日志 |

## 7. 与本地流程的关系

```text
本地（arm64，手机/Ubuntu proot）       CI（x86_64）
─────────────────────────────         ────────────────────────────
tools/verify-engine.sh   ✅ 编译门禁    tools/verify-engine.sh  ✅ 同一脚本
tools/check-engine-anchors.mjs ✅      ——（assets 就位后跑）
assembleSystemDebug      ❌ 无工具链    assembleSystemDebug     ✅ 出 APK
```

验证方式：推一次带 `app/**` 改动的提交，Actions 里应出现 `构建 APK（x86_64 runner）`
且 `assemble` job 绿；下载 `dsh-system-debug` 工件即可装机。
