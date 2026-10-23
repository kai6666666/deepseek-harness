#!/usr/bin/env bash
# deepseek harness / M0 验证脚本
# 用法: bash verify-dsh-web.sh [port] [dsh_home]
# 环境: 任意 arm64 Linux（本机为 Operit 的 PRoot Ubuntu 24.04 + Node 24.19.0）

set -u
PORT="${1:-3080}"
DSH_HOME_DIR="${2:-/root/dsh-m0/home}"
LOG="/tmp/dsh-web-${PORT}.log"

mkdir -p "$DSH_HOME_DIR"
: > "$LOG"

echo "[1/4] 启动 dsh web (port=$PORT, DSH_HOME=$DSH_HOME_DIR)"
DSH_HOME="$DSH_HOME_DIR" nohup dsh web --no-open --port "$PORT" > "$LOG" 2>&1 &
PID=$!
echo "      pid=$PID  log=$LOG"

echo "[2/4] 等待授权 URL 出现在 stdout（最长 120s）"
URL=""
for _ in $(seq 1 120); do
  URL=$(grep -oE "http://127\.0\.0\.1:${PORT}/\?token=[A-Za-z0-9_-]+" "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "      FAIL: 120s 内没有出现授权 URL"
  tail -30 "$LOG"
  exit 1
fi
echo "      URL=$URL"

echo "[3/4] 裸 origin 必须 401（证明不能硬编码 origin）"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/")
echo "      http://127.0.0.1:${PORT}/ -> $code  $([ "$code" = 401 ] && echo OK || echo UNEXPECTED)"

echo "[4/4] 授权 URL 必须 303 + Set-Cookie，跟随 cookie 必须 200"
hdr=$(curl -s -o /dev/null -D - "$URL")
echo "$hdr" | head -6 | sed 's/^/      /'
echo "$hdr" | grep -qi '303' && echo "      303 OK" || echo "      NOT 303"
echo "$hdr" | grep -qi 'set-cookie: dsh-auth-' && echo "      cookie OK" || echo "      NO COOKIE"

body=$(curl -s -c /tmp/dsh-jar -b /tmp/dsh-jar -L "$URL" -o /tmp/dsh-page.html -w '%{http_code} %{size_download}')
echo "      follow -> $body"
head -c 60 /tmp/dsh-page.html | sed 's/^/      /'
echo
echo "RESULT: pid=$PID url=$URL"
