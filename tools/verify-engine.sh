#!/usr/bin/env bash
# verify-engine.sh —— engine 包的独立编译门禁（不需要 Android SDK / Gradle）
#
# 为什么存在：engine/ 只依赖 android.jar + coroutines，可以单独用 kotlinc 做真实类型检查。
# 首次跑出过 3 个"肉眼看不出、真机必炸"的错误（KDoc 里 `*/` 提前闭合、File.relativePath、
# Process.pid()），详见 docs/agents/verification.md。
#
# 用法：
#   ./tools/verify-engine.sh                 # 缓存到 ~/.cache/dsh-kotlinc
#   KTCACHE=/opt/kt ./tools/verify-engine.sh # 复用已有缓存

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/app/src/main/java/com/dsh/android/engine"
CACHE="${KTCACHE:-$HOME/.cache/dsh-kotlinc}"
M="${MAVEN_MIRROR:-https://repo1.maven.org/maven2}"
V="${KOTLIN_VERSION:-2.0.21}"
PLATFORM_ZIP_URL="${PLATFORM_ZIP_URL:-https://dl.google.com/android/repository/platform-35_r02.zip}"

mkdir -p "$CACHE"
cd "$CACHE"

dl() { [ -s "$1" ] && return 0; echo "↓ $1"; curl -fsSL --retry 3 -o "$1" "$2"; }

dl platform-35.zip "$PLATFORM_ZIP_URL"
if [ ! -f platform/android-35/android.jar ]; then
  mkdir -p platform
  unzip -q -o platform-35.zip '*/android.jar' -d platform
fi
ANDROID_JAR="$(find "$CACHE/platform" -name android.jar | head -1)"
[ -n "$ANDROID_JAR" ] || { echo "没解出 android.jar"; exit 2; }

dl kotlin-compiler.jar       "$M/org/jetbrains/kotlin/kotlin-compiler/$V/kotlin-compiler-$V.jar"
dl kotlin-stdlib.jar         "$M/org/jetbrains/kotlin/kotlin-stdlib/$V/kotlin-stdlib-$V.jar"
dl kotlin-reflect.jar        "$M/org/jetbrains/kotlin/kotlin-reflect/1.9.24/kotlin-reflect-1.9.24.jar"
dl kotlin-script-runtime.jar "$M/org/jetbrains/kotlin/kotlin-script-runtime/$V/kotlin-script-runtime-$V.jar"
dl trove4j.jar               "$M/org/jetbrains/intellij/deps/trove4j/1.0.20200330/trove4j-1.0.20200330.jar"
dl coroutines.jar            "$M/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.8.1/kotlinx-coroutines-core-jvm-1.8.1.jar"
dl annotations.jar           "$M/org/jetbrains/annotations/13.0/annotations-13.0.jar"

OUT="$CACHE/out"
rm -rf "$OUT" && mkdir -p "$OUT"

COMPILER_CP="kotlin-compiler.jar:kotlin-stdlib.jar:kotlin-reflect.jar:trove4j.jar:kotlin-script-runtime.jar:coroutines.jar:annotations.jar"
SOURCE_CP="$ANDROID_JAR:coroutines.jar:kotlin-stdlib.jar:annotations.jar"

echo "== 编译 $SRC"
set +e
java -Xmx2g -cp "$COMPILER_CP" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-reflect -nowarn -jvm-target 17 \
  -cp "$SOURCE_CP" \
  -d "$OUT" "$SRC"/*.kt 2>&1 | grep -vE '^warning: unable to find' | tee "$CACHE/compile.log"
RC=${PIPESTATUS[0]}
set -e

if [ "$RC" -ne 0 ]; then
  echo "编译失败（exit=$RC），见 $CACHE/compile.log"
  exit 1
fi

COUNT=$(find "$OUT/com/dsh/android/engine" -name '*.class' 2>/dev/null | wc -l | tr -d ' ')
if [ "${COUNT:-0}" -lt 60 ]; then
  echo "产物数量异常：$COUNT 个 class（期望 > 60）"
  exit 1
fi

echo "✅ engine 包编译通过：$COUNT 个 class"
