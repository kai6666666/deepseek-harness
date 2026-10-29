#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# DSH Android 一键发布：构建两个 release → 传夸克网盘 → 归档旧包
#
# 用法：
#   ./release.sh              # 用 app/build.gradle.kts 里的 versionName
#   ./release.sh 0.3.4        # 显式指定版本名（仅用于文件名，不改源码）
#
# 版本号闸：默认先跑 `sh tools/version.sh --check`，不同源直接中止（构建前拦截）。
#   SKIP_VER_CHECK=1 ./release.sh   # 跳过该闸，仅救急用
#
# 前置：
#   · /etc/profile.d/dsh-build.sh 里的环境变量（JDK / SDK / GRADLE_USER_HOME / DSH_HOME）
#   · app/src/main/assets/ 下的 135 MB 构建资产（不在仓库里，需自备）
#   · keystore.properties + dsh-release.jks（release 签名）
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# 服务器环境变量（JDK / SDK / GRADLE_USER_HOME / DSH_HOME）。本机跑则无需此文件。
[ -f /etc/profile.d/dsh-build.sh ] && source /etc/profile.d/dsh-build.sh

# 项目根 = 本脚本所在目录的上一级。**不要写死绝对路径** ——
# 曾经写成 /mnt/data/dshapp，目录一挪脚本就静默失效（cd 失败才发现）。
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJ=$(cd "$SCRIPT_DIR/.." && pwd)

QUARK=${QUARK_DIR:-/opt/quarkclouddrive}
TMP=${RELEASE_TMP:-/mnt/data/DSHAPP/release-tmp}
mkdir -p "$TMP"
cd "$PROJ" || { echo "❌ 进不去项目根：$PROJ"; exit 1; }
echo "▶ 项目根：$PROJ"

# ── 0. 版本号：优先取参数，否则读 build.gradle.kts ──────────────────────────
if [ -n "${1:-}" ]; then
  VER="$1"
else
  VER=$(sh tools/version.sh --print)
fi
[ -z "$VER" ] && { echo "❌ 读不到 versionName"; exit 1; }
echo "▶ 目标版本：$VER"

# ── 0.5 版本号同源闸（SKIP_VER_CHECK=1 可跳过）──────────────────────────────
# 闸门放在构建之前：拿着「versionName 已改、CHANGELOG 没同步」的源码去打包，
# 出来的包名对、版本对、但用户看到的更新说明是错的，事后无法追溯。
if [ "${SKIP_VER_CHECK:-0}" != "1" ]; then
  if ! sh tools/version.sh --check; then
    echo "❌ 版本号不同源，已中止（先对齐 build.gradle.kts / CHANGELOG，或 SKIP_VER_CHECK=1 强行继续）"
    exit 1
  fi
  echo "✅ 版本号同源"
fi

# ── 1. 构建两个 release ─────────────────────────────────────────────────────
echo "▶ 构建 release（约 1-2 分钟）…"
./gradlew :app:assembleSystemRelease :app:assembleGeckoRelease --console=plain \
  > "$TMP/build.log" 2>&1
if [ $? -ne 0 ]; then
  echo "❌ 构建失败，尾部日志："
  tail -25 "$TMP/build.log"
  exit 1
fi
echo "✅ 构建成功"

SYS_APK="$PROJ/app/build/outputs/apk/system/release/app-system-release.apk"
GCK_APK="$PROJ/app/build/outputs/apk/gecko/release/app-gecko-release.apk"
for f in "$SYS_APK" "$GCK_APK"; do
  [ -f "$f" ] || { echo "❌ 缺产物：$f"; exit 1; }
done

# ── 2. 产物自检：版本号 + 签名 + 关键内容 ──────────────────────────────────
echo "▶ 自检产物…"
BADGING=$("$ANDROID_HOME/build-tools/35.0.0/aapt" dump badging "$SYS_APK" 2>/dev/null | head -1)
case "$BADGING" in
  *"versionName='$VER'"*) echo "  ✅ versionName = $VER" ;;
  *) echo "  ❌ versionName 不匹配：$BADGING"; exit 1 ;;
esac

# 键盘避让是本版新增能力，抽 zip 验一遍（防止 mobile-ui.zip 漏重打）
#
# ⚠️ 这里**不能**写成 `unzip ... | grep -q ...`。
#    本脚本开了 `set -o pipefail`，而 `grep -q` 一命中就立刻退出，
#    上游 `unzip` 随即收到 SIGPIPE 并以 141 结束 —— pipefail 据此判定整条
#    管道失败，于是资产明明正确也会报「是旧的」。这个失败具有欺骗性：
#    单独在命令行复现同样的管道命令往往又"通过"（取决于管道缓冲是否已写完），
#    极难定位。改为先落盘、再对文件 grep，彻底避开 SIGPIPE。
unzip -p "$SYS_APK" assets/mobile-ui.zip > "$TMP/mui.zip" 2>/dev/null
unzip -p "$TMP/mui.zip" lib/client.js > "$TMP/mui-client.js" 2>/dev/null
if grep -q "kbRowSwitch" "$TMP/mui-client.js" 2>/dev/null; then
  echo "  ✅ mobile-ui 含键盘避让卡片"
else
  echo "  ❌ mobile-ui.zip 是旧的（不含 kbRowSwitch）—— 需重打 assets/mobile-ui.zip"
  exit 1
fi

# ── 3. 改名并上传 ──────────────────────────────────────────────────────────
mkdir -p "$TMP"
cp -f "$SYS_APK" "$TMP/DSH$VER.apk"
cp -f "$GCK_APK" "$TMP/DSH$VER-webview.apk"

# FID 每次都变（同一目录连查 3 次拿到 3 个不同值），**绝不能缓存复用**，
# 每次操作前必须现查。
#
# 返回的 JSON 里字段顺序是：fid → parent_fid → filename，
# 所以正则必须按「fid 在前、filename 在后」写。
FID=$(cd "$QUARK" && node scripts/quark-drive.cjs search \
        --keyword 'DSH APP' --search-type dir 2>/dev/null \
      | grep -oP '"fid":"\K[^"]+(?=","parent_fid":"[^"]*","category":[0-9]+,"filename":"DSH APP")' \
      | head -1)
# 兜底：万一夸克改了字段顺序，退化成宽松匹配（先抓含 DSH APP 的那一段，再取段内 fid）
if [ -z "$FID" ]; then
  FID=$(cd "$QUARK" && node scripts/quark-drive.cjs search \
          --keyword 'DSH APP' --search-type dir 2>/dev/null \
        | grep -oP '\{"fid":"\K[^"]+(?="[^}]*"filename":"DSH APP")' | head -1)
fi
[ -z "$FID" ] && { echo "❌ 查不到「DSH APP」目录的 FID"; exit 1; }
echo "▶ 目标目录 FID：${FID: -12}"

for f in "$TMP/DSH$VER.apk" "$TMP/DSH$VER-webview.apk"; do
  name=$(basename "$f")
  echo "▶ 上传 $name（$(du -m "$f" | cut -f1) MB）…"
  OUT=$(cd "$QUARK" && node scripts/quark-drive.cjs upload "$f" --parent-fid "$FID" 2>&1 | tail -1)
  # 同上：用 case 做子串匹配，不用 `echo | grep -q`（SIGPIPE + pipefail 会误判）
  case "$OUT" in
    *'"successCount":1'*) UPLOAD_OK=1 ;;
    *) UPLOAD_OK=0 ;;
  esac
  if [ "$UPLOAD_OK" = 1 ]; then
    echo "  ✅ 落地：$(echo "$OUT" | grep -oP '"fullPath":"\K[^"]+')"
  else
    echo "  ❌ 上传失败：$OUT"
    exit 1
  fi
done

# ── 4. 归档旧包：根目录只留本次两个 ────────────────────────────────────────
echo "▶ 整理目录（旧包 → 历史版本）…"
#
# ⚠️ 夸克 CLI 的 browse 会偶发 `{"code":1007,"msg":"文件列表第 1 页失败"}`
#    （服务端抖动，非权限问题），返回里没有 filename 字段。不重试的话
#    这里会拿到空列表 ⇒ 误报「找不到历史版本」并静默跳过归档，
#    于是根目录越堆越多。必须重试。
LIST=""
for i in 1 2 3 4; do
  LIST=$(cd "$QUARK" && node scripts/quark-drive.cjs browse --parent-fid "$FID" --all 2>/dev/null)
  case "$LIST" in
    *'"filename"'*) break ;;
    *) echo "  ⚠️ browse 第 $i 次失败（夸克抖动），重试…"; sleep 2; LIST="" ;;
  esac
done
[ -z "$LIST" ] && { echo "❌ browse 连续失败，放弃归档（文件已上传成功）"; exit 0; }

HIST_FID=$(echo "$LIST" | grep -oP '"fid":"\K[^"]+(?="[^}]*"filename":"历史版本")' | head -1)
if [ -z "$HIST_FID" ]; then
  HIST_FID=$(echo "$LIST" | grep -oP '"filename":"历史版本"[^}]*?"fid":"\K[^"]+' | head -1)
fi
[ -z "$HIST_FID" ] && { echo "⚠️ 找不到「历史版本」目录，跳过归档"; exit 0; }

# 逐个 apk 判断：不是本次版本的就移走
echo "$LIST" | grep -oP '\{"fid":"[^"]+"[^}]*?"filename":"[^"]+\.apk"' | while read -r item; do
  fname=$(echo "$item" | grep -oP '"filename":"\K[^"]+')
  ffid=$(echo "$item"  | grep -oP '"fid":"\K[^"]+')
  case "$fname" in
    "DSH$VER.apk"|"DSH$VER-webview.apk") echo "  ⏭ 保留 $fname" ;;
    *)
      R=$(cd "$QUARK" && node scripts/quark-drive.cjs move "$ffid" --target-fid "$HIST_FID" 2>&1 | tail -1)
      case "$R" in
        *'"move_path"'*) MOVE_OK=1 ;;
        *) MOVE_OK=0 ;;
      esac
      if [ "$MOVE_OK" = 1 ]; then
        echo "  ✅ $fname → 历史版本"
      else
        echo "  ⚠️ $fname 归档失败：$R"
      fi
      ;;
  esac
done

echo "▶ 完成。根目录应只剩 DSH$VER.apk 与 DSH$VER-webview.apk"
