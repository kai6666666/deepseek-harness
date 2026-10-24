# 构建、发行与发布

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## 构建与验证

⚠️ **本工程有两个 Web 内核 flavor（`system` / `gecko`），构建任务名带 flavor**，
产物也落在带 flavor 的子目录里。细节见 ⑦.7。

```powershell
# 构建（workdir = 本目录）
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"

.\gradlew.bat :app:assembleSystemDebug --console=plain
# 产物：app\build\outputs\apk\system\debug\app-system-debug.apk（约 138 MB）

.\gradlew.bat :app:assembleGeckoDebug --console=plain
# 产物：app\build\outputs\apk\gecko\debug\app-gecko-debug.apk（约 224 MB）

.\gradlew.bat :app:assembleDebug --console=plain   # 两个都出
```

环境：AGP 8.8.2 / Kotlin 2.0.21 / Gradle 8.13 / JDK 17 / compileSdk 35 / minSdk 26。

- **必须显式设 `JAVA_HOME`**，否则取到系统默认 JDK。
- 工程路径含中文（`1-项目代码\安卓开发`），靠 `gradle.properties` 里的
  `android.overridePathCheck=true` 放行，别删。
- 构建需经代理（`gradle.properties` 里的 `127.0.0.1:7897`）。
- ⚠️ **gecko 包约 224 MB**（GeckoView 的 arm64 native 库就占 ~90 MB），比 system 版
  大 86 MB。这是「内核随包分发」的必然代价，不是配置错误。

### 发行版（release）

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"

.\gradlew.bat :app:assembleSystemRelease --console=plain
# 产物：app\build\outputs\apk\system\release\app-system-release.apk（已签名）

.\gradlew.bat :app:assembleGeckoRelease --console=plain
# 产物：app\build\outputs\apk\gecko\release\app-gecko-release.apk（已签名）

.\gradlew.bat :app:assembleRelease --console=plain   # 两个都出
```

⚠️ **两个 release 包的 `applicationId` 不同**（`com.dsh.android` / `com.dsh.webview`），
所以**可以同装一台机器**、各自独立的数据目录。但**同一个 flavor 下 debug 与 release
会互斥**（共用 applicationId、签名不同）—— 换装要先卸载 ⇒ 数据全丢，自用机保持 debug 不动。

**debug 是自用包、release 是发给别人的包，两把钥匙互相独立。**

- 签名凭据是仓库根的 `keystore.properties`（指向 `dsh-release.jks`），
  **两者都不入库**（`.gitignore` 已覆盖），`app/build.gradle.kts` 读它配
  `signingConfigs.release`。**文件不存在时自动跳过签名**，产物退化成
  `app-release-unsigned.apk` —— 别人 clone 后就是这个状态，`assembleDebug`
  完全不受影响。
- ⚠️ **这把钥匙是发行版的终身身份，发出去就不能换。** 换签名 ⇒ 老用户撞
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` ⇒ 只能卸载重装，而卸载会清掉 `filesDir`
  下的整个 Termux 环境与 `$DSH_HOME`（会话、凭据、工作区全没）。
  **`dsh-release.jks` 与 `keystore.properties` 必须一起离线备份**，丢了同样发不出更新。
- 侧载**不需要买 CA 证书**，`keytool` 自签即可（Android 只校验前后一致，不校验链）。
  当前证书 `CN=DSH Android, O=DSH, C=CN`，RSA 4096，有效期 10000 天；
  `apksigner verify` 显示走 **v2 方案**（`minSdk 26` 用不上 v1）。
- ⚠️ **`lintVitalRelease` 的 `ExpiredTargetSdkVersion` 会因 `targetSdk = 28` 直接判
  release 构建失败**（报 "Google Play requires that apps target API level 33 or higher"）。
  已在 `app/build.gradle.kts` 的 `lint {}` 里**只关掉这一条**——本 App 只能侧载、
  不上架 Play，该检查在这里无意义——其余 lint 检查保持生效，别改回去。
  根因是硬约束②，**不要试图靠升 `targetSdk` 来"修"它**。
- ⚠️ debug 与 release **共用 `applicationId`**，同一台设备上只能存在一个；从 debug
  换装 release（或反之）会因签名不同而要求先卸载 ⇒ 数据全丢。自用机保持 debug 不动。

#### 发布到夸克网盘

发行包的对外分发走**夸克网盘**，目标是这个目录：

```
夸克网盘 / jiulingShare / DSH APP
```

里面已有的包用 `DSH<versionName>.apk` 命名（如 `DSH0.1.0.apk`）。**同名会冲突，
所以每次发布都在版本号后面加个后缀**，例如 `DSH0.1.0-pool.apk`（内置号池版）、
`DSH0.1.0-fixport.apk`。后缀随意，能区分就行。

##### 两个内核版本一起发

从 0.2.6 起有 **system / gecko 两个 flavor**，所以一次发布要传**两个包**，
后缀必须能区分是哪一个：

| flavor | 上传时改成的名字 | 说明 |
|---|---|---|
| system | `DSH<versionName>.apk` | 老包沿用原命名，绝大多数人装这个 |
| gecko | `DSH<versionName>-webview.apk` | 内置 Web 内核版，体积大一倍 |

⚠️ **两个包互不冲突、可以同时装**（applicationId 不同），所以**不能**把其中一个
挪进「历史版本」—— 它们不是新旧关系，是**并列的两个版本**。根目录里同时留住两个。

**必须走 Git 自带的 bash**（Windows 自带的 `bash.exe` 是 WSL，环境不对）：

```powershell
$bash = "C:\Program Files\Git\bin\bash.exe"
$skill = "/c/Users/你的用户名/.claude/skills/quarkclouddrive"

# 1) 先查目标目录的 FID（⚠️ 每次都要现查，见下）
& $bash -lc "cd $skill && node scripts/quark-drive.cjs search --keyword 'DSH APP' --search-type dir 2>&1"

# 2) 把包拷成要发布的名字（upload 用的是本地文件名，所以先改名再传）
Copy-Item app\build\outputs\apk\release\app-release.apk "$env:TEMP\DSH0.1.0-pool.apk" -Force

# 3) 上传（--parent-fid 填上一步查到的 FID）
& $bash -lc "cd $skill && node scripts/quark-drive.cjs upload '/c/Users/你的用户名/AppData/Local/Temp/DSH0.1.0-pool.apk' --parent-fid '<FID>' 2>&1" |
  Select-Object -Last 4
```

成功的收尾行长这样（`fullPath` 就是落地位置，**以此为准**）：

```json
{"code":0,"msg":"成功","data":{"fileNames":["DSH0.1.0-pool.apk"],"successCount":1,
 "instantUpload":true,"fullPath":"夸克网盘/jiulingShare/DSH APP"},"action":"upload","type":"result"}
```

⚠️ **`--parent-fid` 不能省略，也不能硬编码。** 省略会直接失败：

```
{"code":14001,"msg":"参数错误: [upload dir blank]","action":"upload","type":"result"}
```

而 FID **每次查询都在变**（实测同一个「DSH APP」目录，三次拿到三种前缀，只有
竖线后面的后缀 `|JkamYKaMIaE` 稳定）。所以**每次上传前重新 `search` 一次拿当前
FID**，不要从上一次的输出里复制。

⚠️ **`--parent-fid 0` 是根目录**（实测可用）。只有明确要传到根目录时才用它 ——
发行包**不该**传根目录，那是放错位置。

⚠️ **这个 CLI 没有删除命令**（`--help` 里 25 个命令逐个看过，没有 delete/rm/trash）。
**传错位置只能去夸克 App 或网页端手动删**。所以上传前先确认 `--parent-fid` 是对的 ——
这条踩过一次（包落到了根目录）。

其他实测要点：

- **进度是 NDJSON 刷屏**：一次上传打几百行 `{"msg":"进行中",...}`，必须
  `| Select-Object -Last 4` 收尾，别把全量倒出来（132 MB 那次刷了 185 KB 日志）。
- **秒传**：同内容文件已存在时 `instantUpload: true`，几秒就完（第二次传同一个包就是
  这样），所以重复上传不浪费流量。
- **账号**：昵称 `小强`，容量 20 TB 级。`get-user-info` 可验授权；它失败才说明授权
  失效（需 `login --token <授权码>` 重新授权），单条命令失败不算。
- ⚠️ **只能在 Windows 本机跑**（依赖 node）。Termux / Android 端没有 node，用不了。

#### ⚠️ 发布完必须整理目录：旧版挪进「历史版本」

`DSH APP` 根目录**只留最新一个包**，被它取代的旧包一律移进子目录
`DSH APP/历史版本/`。目录里那个 `保存此文件夹持续更新中.txt` 是分享说明，
不是包，别动。

**这一步是发布的一部分，不是可选收尾。** 漏做的后果是根目录堆着一串版本、
分享链接的访客分不清该下哪个。

```powershell
# 1) 列出根目录，拿到「旧包」与「历史版本」两个 FID
#    ⚠️ 每次都要现查：FID 前缀每次都变，只有竖线后的后缀稳定
& $bash -lc "cd $skill && node scripts/quark-drive.cjs browse --parent-fid '<DSH APP 的 FID>' --all 2>&1"

# 2) 移动（fids 是位置参数，目标目录用 --target-fid）
& $bash -lc "cd $skill && node scripts/quark-drive.cjs move '<旧包的 FID>' --target-fid '<历史版本的 FID>' 2>&1"
```

成功时 `move_path` 会回显落地位置，**以此为准**：

```json
{"code":0,"msg":"成功","data":{"fids":["~1E2xIos…|Z7KnYr6cf84"],
 "targetFid":"~1gZvlvk…|H_y2_NbMY0Q",
 "move_path":"夸克网盘/jiulingShare/DSH APP/历史版本"},"action":"move","type":"result"}
```

**什么算「旧包」**：同一次发布里如果因为返工传了第二个包（如 `DSH0.2.3.apk`
→ `DSH0.2.3-icons.apk`），根目录留**最后上传的那个**，先前那个进历史版本 ——
即使两者 `versionName` 相同。

⚠️ `move` 是**移动**不是复制，根目录里那一条会消失；移动完回查两个目录确认
（根目录少一个、历史版本多一个）。

⚠️ 实测 `历史版本` 目录的 FID 后缀是 `|H_y2_NbMY0Q`、`DSH APP` 是
`|JkamYKaMIaE`，但**前缀每次查询都变，所以仍然必须现查**，不能拿后缀凑 FID。

```powershell
# 安装 + 启动（adb 在 %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe）
adb install -r app\build\outputs\apk\debug\app-debug.apk
adb logcat -c ; adb shell am start -n com.dsh.android/.MainActivity
```

**「构建成功」不等于「改动生效」。** 用日志确认（TAG 恒为 `DSH`）：

```powershell
adb logcat -d -s DSH:I
```

关键行：

| 日志 | 含义 |
|---|---|
| `已安装移动端 UI 插件 dsh-android-mobile <版本> (<N> 字节)` | 插件已解包 |
| `已注入 WebView 兼容补丁: webview-polyfill.js` | polyfill 已注入 |
| `已安装原生插件 node-addon-require-builtin-android-arm64` | 原生插件已就位 |
| `已安装 system 插件 @deepseek-ai/node-addon-system-android-arm64` | flock 绑定已就位 |
| `已放行 flock 的 android 平台: flock.js` | 平台白名单已补 android |
| `已安装 ripgrep @vscode/ripgrep-android-arm64 (<N> 字节)` | grep/glob 的搜索二进制已就位 |
| `已安装 sharp wasm 变体 (@img/sharp-wasm32, <N> 字节)` | 图片附件的图像处理已就位 |
| `已放行附件模块的祖先目录 fsync: dsh-attachment-local` | 附件发布的目录 fsync 已容错 |
| `已安装 node-pty android-arm64 绑定 (<N> 字节)` | 终端面板的 PTY 绑定已就位 |
| `已放行 subprocess-local 的 android 进程检查器: runner-launch-<hash>.js` | 终端后端的进程检查器已放行 android |
| `已安装 pnpm 11.28.3 (<N> 个文件, <M> 字节启动脚本)` | 插件管理器可用了 |
| `已解出沙箱 runner boo-sandbox-run (<N> 字节) + libboosandbox.so (<N> 字节)` | 沙箱组件已落盘 |
| `已写入沙箱 overlay: sandbox.patch.yml` | 沙箱 runner 已挂上 |
| `已解出 link 兼容层 liblinkcompat.so (<N> 字节)` | link 转译层已落盘（并会被 LD_PRELOAD） |
| `已还原目录选择器的起始目录（改由主目录下的入口链接提供）` | 老安装里「起点改 /sdcard」的补丁已撤回（见 ③.5） |
| `已建工作区入口: 手机存储 → /sdcard` | HOME 下的入口链接已就位（只首次启动打印，见 ③.5） |
| `Web 端口 3080 空闲，沿用引擎默认值` | 正常路径，端口与改动前一致（见 ⑭） |
| `Web 端口 3080 已被占用（多半是上一次残留的引擎进程），改由内核分配空闲端口` | 撞上残留进程，已改传 `--port 0`（见 ⑭） |
| `[engine] dsh web: http://127.0.0.1:3080/?token=...` | 引擎打印了带 token 的 URL |
| `引擎就绪: http://...` | App 解析到 URL |
| `WebView 加载完成: http://127.0.0.1:3080/` | 前端已加载 |

WebView 内的 `console.log` 也会转发到同一 TAG，前缀 `[web]`。

