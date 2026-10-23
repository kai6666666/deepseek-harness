#!/usr/bin/env bash
# deepseek harness / Kotlin 类型检查（无需 Android SDK、无需 Gradle）
#
# 背景：本机是 arm64，Android build-tools 的 aapt2 只有 x86_64 Linux 版，
# 所以「出 APK」必须在 PC 上做；但「编译验证 Kotlin 源码」在这台机器上可以真跑。
#
# 依赖（脚本自动下载，缓存到 $CACHE）：
#   android.jar          platform-36_r02.zip        ~63 MB
#   kotlin-compiler      2.0.21 embeddable          ~58 MB
#   kotlin-stdlib        2.0.21
#   trove4j              1.0.20200330   （编译器自身依赖）
#   annotations          13.0           （代码生成必需）
#   kotlinx-coroutines   1.9.0 jvm
#   androidx 若干部件     core / appcompat / activity / fragment / lifecycle / webkit
#
# 用法：bash tools/typecheck-kotlin.sh
set -u

CACHE="${CACHE:-/root/kc}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/app/src/main/java/ai/deepseek/harness"
OUT="${OUT:-/tmp/dsh-typecheck-out}"
M2="https://repo1.maven.org/maven2"
G2="https://dl.google.com/dl/android/maven2"

mkdir -p "$CACHE/aar" "$CACHE/libs" "$OUT"
cd "$CACHE" || exit 1

fetch() { [ -s "$2" ] || curl -sSL -o "$2" "$1"; }

echo "[1/4] 编译器与平台"
fetch "https://dl.google.com/android/repository/platform-36_r02.zip" platform36.zip
[ -d plat ] || python3 -c "import zipfile; zipfile.ZipFile('platform36.zip').extractall('plat')"
ANDROID_JAR=$(find plat -name android.jar | head -1)

fetch "$M2/org/jetbrains/kotlin/kotlin-compiler-embeddable/2.0.21/kotlin-compiler-embeddable-2.0.21.jar" kc.jar
fetch "$M2/org/jetbrains/kotlin/kotlin-stdlib/2.0.21/kotlin-stdlib-2.0.21.jar" stdlib.jar
fetch "$M2/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.9.0/kotlinx-coroutines-core-jvm-1.9.0.jar" coro.jar
fetch "$M2/org/jetbrains/intellij/deps/trove4j/1.0.20200330/trove4j-1.0.20200330.jar" trove.jar
fetch "$M2/org/jetbrains/annotations/13.0/annotations-13.0.jar" ann.jar
fetch "$M2/org/nanohttpd/nanohttpd/2.3.1/nanohttpd-2.3.1.jar" libs/nanohttpd-2.3.1.jar

echo "[2/4] androidx jar"
for p in \
  "androidx/annotation/annotation/1.8.0/annotation-1.8.0.jar" \
  "androidx/collection/collection/1.4.5/collection-1.4.5.jar" \
  "androidx/lifecycle/lifecycle-common-jvm/2.8.6/lifecycle-common-jvm-2.8.6.jar" \
  "androidx/core/core/1.13.1/core-1.13.1.aar" \
  "androidx/core/core-ktx/1.13.1/core-ktx-1.13.1.aar" \
  "androidx/activity/activity/1.9.3/activity-1.9.3.aar" \
  "androidx/fragment/fragment/1.8.5/fragment-1.8.5.aar" \
  "androidx/lifecycle/lifecycle-runtime-android/2.8.6/lifecycle-runtime-android-2.8.6.aar" \
  "androidx/lifecycle/lifecycle-runtime-ktx-android/2.8.6/lifecycle-runtime-ktx-android-2.8.6.aar" \
  "androidx/lifecycle/lifecycle-viewmodel-android/2.8.6/lifecycle-viewmodel-android-2.8.6.aar" \
  "androidx/lifecycle/lifecycle-service/2.8.7/lifecycle-service-2.8.7.aar" \
  "androidx/savedstate/savedstate/1.2.1/savedstate-1.2.1.aar" \
  "androidx/appcompat/appcompat/1.7.0/appcompat-1.7.0.aar" \
  "androidx/webkit/webkit/1.12.1/webkit-1.12.1.aar" \
; do
  n=$(basename "$p")
  fetch "$G2/$p" "aar/$n"
  case "$n" in
    *.jar) [ -s "libs/$n" ] || cp "aar/$n" "libs/$n" ;;
    *.aar) [ -s "libs/${n%.aar}.jar" ] || python3 -c "
import zipfile,sys
zipfile.ZipFile('aar/$n').extract('classes.jar','/tmp/x')
import shutil; shutil.move('/tmp/x/classes.jar','libs/${n%.aar}.jar')
" ;;
  esac
done

echo "[3/4] 编译 $SRC"
CP="$ANDROID_JAR:coro.jar:stdlib.jar:ann.jar:$(ls libs/*.jar | tr '\n' ':')"
FILES=()
for f in "$SRC"/*.kt; do FILES+=("$f"); done
echo "      sources: ${#FILES[@]}"
java -Xmx2g -cp "kc.jar:stdlib.jar:coro.jar:trove.jar:ann.jar" \
  org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -jvm-target 17 -cp "$CP" -d "$OUT" \
  "${FILES[@]}"
RC=$?

echo "[4/4] 结果"
if [ $RC -eq 0 ]; then
  echo "TYPE CHECK OK · classes=$(find "$OUT" -name '*.class' | wc -l)"
else
  echo "TYPE CHECK FAILED rc=$RC"
fi
exit $RC