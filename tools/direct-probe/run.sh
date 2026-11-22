#!/system/bin/sh
# Direct-launch probe（P4-a）：用 glibc loader 直接跑 rootfs 里的 node + dsh web。
#
# 用法：sh run.sh <app-files-dir> [port]
# 例：  sh run.sh /data/user/0/com.dsh.android/files 46991
#
# 不碰 App 数据：DSH_HOME / DSH_USER_HOME 指向隔离目录；不写 pid、不改 manifest、不占 App 端口。
set -u
A=${1:?usage: run.sh <app-files-dir> [port]}
PORT=${2:-46991}
RF=$A/runtime/rootfs
P=$A/direct-probe
L=$RF/usr/lib/aarch64-linux-gnu

[ -x "$RF/usr/bin/node" ] || { echo "找不到 $RF/usr/bin/node（rootfs 未就绪？）"; exit 9; }
[ -x "$L/ld-linux-aarch64.so.1" ] || { echo "找不到 $L/ld-linux-aarch64.so.1"; exit 9; }

mkdir -p "$P/dsh" "$P/userhome" "$RF/tmp"
export HOME=$RF/root
export DSH_HOME=$P/dsh
export DSH_USER_HOME=$P/userhome
export DSH_FILES=$A
export TMPDIR=$RF/tmp TMP=$RF/tmp TEMP=$RF/tmp
export PATH=$RF/usr/local/bin:$RF/usr/bin:$RF/bin:$RF/usr/sbin:$RF/sbin
export NODE_PATH=$RF/opt/dsh/node_modules
export SSL_CERT_FILE=$RF/etc/ssl/certs/ca-certificates.crt
export NODE_OPTIONS=${NODE_OPTIONS:---dns-result-order=ipv4first}
export LANG=${LANG:-C.UTF-8}
export TERM=xterm-256color
export TZ=${TZ:-Asia/Shanghai}

cd "$RF/root" || exit 9
echo "T0 $(/system/bin/date +%s%3N)"
exec "$L/ld-linux-aarch64.so.1" \
  --library-path "$L:$RF/lib/aarch64-linux-gnu:$RF/usr/lib:$RF/lib" \
  "$RF/usr/bin/node" \
  "$RF/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" web \
  --host 127.0.0.1 --port "$PORT" --no-open
