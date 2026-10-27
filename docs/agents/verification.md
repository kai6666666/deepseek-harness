# 引擎包独立编译验证

> 目的：在没有 Android SDK / Gradle 全量工具链的环境里，也能对 `app/src/main/java/com/dsh/android/engine/` 做**真实的类型检查**（不是肉眼审阅）。
> 记录时间：2026-10-26

## 为什么单独编 engine 包

`engine/` 是纯新增包，只依赖 `android.*`、`org.json`、`kotlinx.coroutines`，**不反向依赖 `EngineManager` / `MainActivity`**。
所以可以用「kotlinc + android.jar + coroutines」把它整体编成 .class，当作 CI 之外的快速门禁。

## 一次性环境准备（约 130 MB）

```bash
mkdir -p /opt/kt && cd /opt/kt
M=https://repo1.maven.org/maven2/; V=2.0.21
curl -L -o platform-35.zip https://dl.google.com/android/repository/platform-35_r02.zip
unzip -q -o platform-35.zip '*/android.jar' -d platform
curl -L -o kotlin-compiler.jar  $M/org/jetbrains/kotlin/kotlin-compiler/$V/kotlin-compiler-$V.jar
curl -L -o kotlin-stdlib.jar    $M/org/jetbrains/kotlin/kotlin-stdlib/$V/kotlin-stdlib-$V.jar
curl -L -o kotlin-reflect.jar   $M/org/jetbrains/kotlin/kotlin-reflect/1.9.24/kotlin-reflect-1.9.24.jar
curl -L -o kotlin-script-runtime.jar $M/org/jetbrains/kotlin/kotlin-script-runtime/$V/kotlin-script-runtime-$V.jar
curl -L -o trove4j.jar          $M/org/jetbrains/intellij/deps/trove4j/1.0.20200330/trove4j-1.0.20200330.jar
curl -L -o coroutines.jar       $M/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.8.1/kotlinx-coroutines-core-jvm-1.8.1.jar
curl -L -o annotations.jar      $M/org/jetbrains/annotations/13.0/annotations-13.0.jar
```

> 四个坑，按顺序踩过：
> 1. 编译器自己依赖 `kotlinx.coroutines` → 必须把 coroutines 放进 **编译器 classpath**，否则 `NoClassDefFoundError`；
> 2. 不给 `-no-stdlib` 时它会去 Kotlin home 找 stdlib（我们的 jar 是散的）→ 用 `-cp` 显式传入并保持 `-no-reflect`；
> 3. 少了 `org.jetbrains.annotations` 会在**后端 IR 生成**阶段抛 `NoClassDefFoundError: org/jetbrains/annotations/NotNull`（看起来像编译器崩，其实是缺 jar）；
> 4. `android.jar` 里的 `java.lang.Process` 是 libcore 桩，**没有 `pid()`** —— 见下面第 3 个真实缺陷。

## 一条命令跑完

```bash
cd /opt/kt
CP="kotlin-compiler.jar:kotlin-stdlib.jar:kotlin-reflect.jar:trove4j.jar:kotlin-script-runtime.jar:coroutines.jar:annotations.jar"
SRC=<repo>/app/src/main/java/com/dsh/android/engine
rm -rf /tmp/ktout && mkdir -p /tmp/ktout
java -Xmx2g -cp "$CP" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-reflect -nowarn -jvm-target 17 \
  -cp "/opt/kt/platform/android-35/android.jar:/opt/kt/coroutines.jar:/opt/kt/kotlin-stdlib.jar:/opt/kt/annotations.jar" \
  -d /tmp/ktout "$SRC"/*.kt
ls /tmp/ktout/com/dsh/android/engine | wc -l   # 期望 > 60
```

## 首次跑出的 3 个真实缺陷（已修）

| # | 文件 | 现象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | `EngineHost.kt` | `syntax error: Expecting a top level declaration`（一大片） | KDoc 里写了 `` `ensure*/patch*/write*` ``，其中的 `*/` **提前闭合了块注释** | 改成 `` `ensure*` / `patch*` / `write*` `` |
| 2 | `AnchorAudit.kt` | `unresolved reference 'relativePath'` | `File` 没有 `relativePath` 属性 | 改用 `f.path` |
| 3 | `ProotGlbcHost.kt`、`EngineManager.kt` | `unresolved reference 'pid'` | `Process.pid()` 是 Java 9 API，`android.jar` 的 libcore 桩里没有 | 新增 `ProcPid.of(process)`：反射调用，取不到返回 null |

**结论**：这三个都是“肉眼审阅不会发现、真机编译必炸”的类型错误——独立编译门禁值得保留。

## 本次结果

```text
exit=0
classes=62
```

覆盖：`EngineHost` / `EngineHosts` / `ProotGlbcHost` / `EngineBootGate` / `RootfsProvisioner` / `VerifyC` / `McpBridge` / `McpWiring` / `AndroidCapabilitiesImpl` / `AnchorAudit` / `PrivilegedRunner` / `ProcPid`。

## 还不能验证的部分（必须说明）

- `EngineManager.kt`、`MainActivity.kt`：依赖整个 App（Context、R、PageBridge、UiProbeBridge…），**只能靠 Gradle 全量构建**；
- 本机无 Android SDK platform/build-tools 全套，`assembleSystemDebug` 未跑；
- 因此“能编”目前只对 `engine/` 包成立，对两个被改的大文件是“改法经过类型推演 + 相同 API 已被 engine 包验证”。

## CI 门禁（已接入）

`.github/workflows/ci.yml` 新增 job `engine-compile`：

1. `actions/setup-java@v4`（temurin 17）；
2. 缓存 `~/.cache/dsh-kotlinc`（约 130 MB，key 跟随 kotlin 版本）；
3. 执行 `./tools/verify-engine.sh`（下载缺失 jar → 编译 → class 数 > 60 才算过）。

本地等价命令：`KTCACHE=/opt/kt ./tools/verify-engine.sh`。
成本：无 Gradle、无 SDK 许可，一次缓存后每次约 40 秒。

## 「通了」的四条判据（别再用一句「UI 能操作」含糊）

真机上很多结论互相矛盾，根源是「通」没定义。现在拆成四条，各自有独立、可复现的判据。
记录时间：2026-10-27。

### ① 引擎包完整性

```bash
run-as com.dsh.android sh -c 'grep -h "引擎完整性断言通过" files/logs/*.log | tail -1'
# 期望：引擎完整性断言通过：条目 54554，文件 47916，字节 397584889
```

三个数字必须**同时**与 `engine.bin` 的归档声明一致；少一个都是解包被截断（见
`TarGz` 的 GNU `@LongLink` / 名字读空 两个旧缺陷）。

### ② 四个原生模块就位

```bash
run-as com.dsh.android sh -c 'grep -hE "require-builtin|node-pty|sharp|flock" files/logs/engine.log | tail -8'
```

判据是**没有**「未找到」字样，而不是「有一行提过它」。

### ③ 工具链通（会话内模型 → 工具 → 原生 → 回注）

会话存档是 zstd：`files/home/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd`。
设备上没有 `zstd` 命令，`cp` 到 `/sdcard` 又被 FUSE 权限挡住，用 app 自己的 node 解（见 `tools/zread.mjs`）：

```bash
run-as com.dsh.android sh -c 'N=/data/user/0/com.dsh.android/files/termux/usr/bin/node;\
D=/data/user/0/com.dsh.android/files/home/.dsh/sessions;\
F=$(ls -t $D/*/*/session.v4.jsonl.zstd | head -1);\
$N /data/local/tmp/zread.mjs "$F" 6'
```

（先把 `tools/zread.mjs` 推到 `/data/local/tmp/zread.mjs` 并 `chmod 644`；它只做「解压 + 过滤 tool 事件」两件事。）

判据（两条同时成立）：

1. 同一 turn 内 `tool/call` 与 `tool/result` **成对**出现；
2. `tool/result` 正文是 `2000`，且 stderr 带 `[dsh-adb] 通道: Shizuku（uid 2000）`。

证据形状：

```json
{"type":"tool/call","seq":69,"name":"shell","arguments":"{\"command\":\"id -u\"}"}
{"type":"tool/result","seq":70,"content":"2000\n[stderr]\n[dsh-adb] 通道: Shizuku（uid 2000）","isError":false}
```

### ④ UI 句柄通（模型能拿着 dump 给的句柄回写）

```bash
# 1) dump
printf '%s' '{"id":1,"action":"dump","limit":400}' > files/home/.dsh/ui-cmd.json
# 2) 从回执里取 role=textbox 的 ref（形如 e48）
# 3) 写（扁平写法；未聚焦先 tap {ref}）
printf '%s' '{"id":2,"action":"type","ref":"e48","value":"hello","clear":true}' > files/home/.dsh/ui-cmd.json
```

判据：`ok:true` **且** `applied:true` **且** `value` 含 `hello`。

⚠️ `ok:true` 单独不算：`applied:null` + `value:""` 表示 `execCommand` 空转（选区没落进元素）。

⚠️ 另有一条与它并列的「坐标通」：用 dump 的 `screenCenter` 直接 `input tap`，
`am start → tap → input text → tap` 串成**一条** adb 命令执行（设备会被其它 App 抢前台，
分多条必断），然后 `screencap` 看到消息真的发出去。这条路已验证能驱动整轮会话。

### 四条的当前状态

| # | 判据 | 状态 |
|---|---|---|
| ① | 完整性断言三数字 | ✅ 54554 / 47916 / 397584889 |
| ② | 四模块无「未找到」 | ✅ |
| ③ | tool/call ↔ tool/result = 2000 | ✅ 两次实证 |
| ④ | dump→ref→type `applied:true` | ✅ 2026-10-27 真机，两种写法都验过：`ok:true / cleared:"已是空的" / value:"caret-test…"`（扁平）与 `ok:true / applied:true / value:"nested-args-test"`（`args` 嵌套，靠 `flattenArgs`） |
| ④b | `clear:true` 是**替换**而非追加 | ✅ `cleared:"selectAll(交给 insertText 替换)"` + `value:"BBB-only"`（屏幕上同步确认） |

### ⑤ 开发环境（六组）——设置页「开发环境」的验收

这一条验的是**可选环境**（Python / SSH / Java / Rust / Go）能否装、能卸、能如实报错。
全部命令都在设备上（`run-as` + App 自带 node）。

```bash
# 1) 状态：必须 6 组，且计数与界面一致
run-as com.dsh.android sh -c 'N=/data/user/0/com.dsh.android/files/termux/usr/bin/node; \
D=/data/user/0/com.dsh.android/files; $N $D/dsh-env.mjs status --json' | python3 -c 'import json,sys;d=json.load(sys.stdin);print([(g["id"],f"{g["installedCount"]}/{g["totalCount"]}") for g in d["groups"]])'
```

期望（2026-10-27 真机）：

```text
[('nodejs','2/2'), ('python','5/5'), ('ssh','3/3'), ('java','2/2'), ('rust','1/2'), ('go','1/1')]
```

```bash
# 2) 单项装 / 卸（用 uv 这种 30 MB 的做样本，30 秒内出结果）
$N $D/dsh-env.mjs install python.uv
$N $D/dsh-env.mjs verify  python.uv    # 期望 ok:true + uv 0.13.5
$N $D/dsh-env.mjs remove  python.uv
$N $D/dsh-env.mjs verify  python.uv    # 期望 exit 1，ok:false

# 3) 批量（对应界面上“多项勾选 + 开始配置”）
$N $D/dsh-env.mjs install ssh.sshpass java.gradle   # 两个 id 一次提交

# 4) unsupported 项：rustup 必须**始终** installed:false（哪怕 ~/.cargo 有残留）
$N $D/dsh-env.mjs status --json | grep -o '"id":"rust.rustup"[^}]*"installed":[a-z]*'
```

判据（四条同时成立才算通过）：

1. `groups.length == 6`，且每组 `installedCount ≤ totalCount`；
2. 装完 `verify ok:true`、卸完 `verify` exit=1；
3. 批量提交后 `devenv-job.json` 的 `ids` 是数组（长度 = 提交项数），日志里 **apt 类串行、非 apt 并行**；
4. 卸载后：`$PREFIX/bin/<主二进制>` 不存在；`cleanupDirs` 里的目录（如 `$PREFIX/opt/gradle`）不存在。

已知边界（不是缺陷，别当回归）：

| 项 | 说明 |
|---|---|
| `rust.rustup` | Android 上 rustls 平台校验 panic → 永久 `unsupported`，界面置灰 |
| 未纳管项 | 手动 `apt` 装的项没有 `env-state.json` 记录 → 卸载按**声明包名**兜底，体积显示“未纳管” |
| 幽灵文件 | apt 被信号打断时 dpkg 无记录但二进制还在 → 卸载末尾会补删该二进制 |
