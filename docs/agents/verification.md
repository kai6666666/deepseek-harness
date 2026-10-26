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

## 后续：接进 CI

`.github/workflows/ci.yml` 加一个 job：下载上面 8 个 jar + android.jar → 跑本节命令 → 失败即红。
成本低（无 Gradle、无 SDK 许可），能抓住上面那类错误。
