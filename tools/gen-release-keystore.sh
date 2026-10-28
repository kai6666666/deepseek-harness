#!/bin/sh
# gen-release-keystore.sh —— 生成一把发行签名（只跑一次，生成后终身使用）
#
# 用法：sh tools/gen-release-keystore.sh [别名] [dname]
# 产出：仓库根 keystore.jks + keystore.properties（0600，均已被 .gitignore 排除）
#
# 为什么强调「只跑一次」：签名是应用身份。换签名 = 老用户撞
# INSTALL_FAILED_UPDATE_INCOMPATIBLE，只能卸载重装，而卸载会清空 filesDir 下的
# Termux 环境与 $DSH_HOME。丢了这把 key = 再也发不出能覆盖升级的包。
ROOT=$(cd "$(dirname "$0")/.." && pwd)
KS="$ROOT/keystore.jks"
PROP="$ROOT/keystore.properties"
ALIAS="${1:-dsh-release}"
DN="${2:-CN=DeepSeek Harness, OU=Android, O=DSH, C=CN}"

if [ -f "$KS" ]; then
  echo "already exists: $KS"
  echo "reuse it. 重新生成会让所有老用户装不上。"
  exit 0
fi

PW=$(head -c 200 /dev/urandom | tr -dc 'A-Za-z0-9' | cut -c1-24)
[ -z "$PW" ] && PW="dsh$(date +%s)Kx"

keytool -genkeypair -v -keystore "$KS" -alias "$ALIAS" -keyalg RSA -keysize 4096 \
  -validity 10950 -storepass "$PW" -keypass "$PW" -dname "$DN" >/dev/null 2>&1
RC=$?
if [ $RC -ne 0 ] || [ ! -f "$KS" ]; then
  echo "keytool failed rc=$RC"
  exit 1
fi

printf 'storeFile=keystore.jks\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' \
  "$PW" "$ALIAS" "$PW" > "$PROP"
chmod 600 "$KS" "$PROP"

echo "---- created ----"
echo "keystore : $KS"
echo "props    : $PROP"
echo "alias    : $ALIAS"
keytool -list -v -keystore "$KS" -storepass "$PW" -alias "$ALIAS" | grep -E 'SHA1:|SHA256:'
sha256sum "$KS"
echo "---- 备份 ----"
echo "把 keystore.jks 与 keystore.properties 离线备份两份；口令只存在后者里。"