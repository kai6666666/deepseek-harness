#!/system/bin/sh
# provision-glibc-host.sh —— 把 C 方案的环境装起来（幂等，可重复跑）
#
# 由 RootfsProvisioner 调起：/system/bin/sh <filesDir>/bin/provision-glibc-host.sh
# 也可在 Termux 里手工跑：
#   FILES=/data/data/com.dsh.android/files sh provision-glibc-host.sh
#
# 它做四件事：
#   1) 校验 proot / rootfs / 网络配置
#   2) 在 rootfs 内装 Node（glibc）+ @deepseek-ai/dsh
#   3) 编译三个 C 适配产物（boo-sandbox-run / libboosandbox.so / liblinkcompat.so）
#   4) 打印一份「还缺什么」，退出码 0 才算装配完成
#
# ⚠️ 不用 `set -e`：每步都要独立结算，失败要继续把剩余诊断跑完。

FILES="${FILES:-/data/data/com.dsh.android/files}"
ROOT="$FILES/ubuntu"
PROOT="$FILES/bin/proot"
SRC="$FILES/bin/jni"                 # 三个 .c 由 App 从 assets 复制到这里
DSH_VER="${DSH_VER:-0.2.1-rc.3}"
NODE_MAJOR="${NODE_MAJOR:-24}"

ok()   { echo "✅ $1"; }
bad()  { echo "❌ $1"; FAILED=1; }
FAILED=0

echo "== 前置 =="
[ -x "$PROOT" ] && ok "proot: $PROOT" || bad "缺可执行的 proot: $PROOT（静态 aarch64）"
[ -x "$ROOT/usr/bin/env" ] && ok "rootfs: $ROOT" || bad "rootfs 未解包: $ROOT（ubuntu-base）"

if [ "$FAILED" = "1" ]; then
  echo
  echo "前置不全，停止。修复后再跑一次。"
  exit 1
fi

# ── 在 rootfs 内执行（统一入口，避免每条命令重复拼 proot 参数）────────────
prun() {
  "$PROOT" --kill-on-exit -r "$ROOT" \
    -b /dev -b /proc -b /sys \
    -w /root \
    /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /bin/sh -lc "$*"
}

echo
echo "== DNS =="
if [ -f /etc/resolv.conf ]; then
  cp -f /etc/resolv.conf "$ROOT/etc/resolv.conf" 2>/dev/null && ok "已复制 resolv.conf"
else
  printf 'nameserver 223.5.5.5\nnameserver 8.8.8.8\n' > "$ROOT/etc/resolv.conf"
  ok "已写入公共 DNS"
fi

echo
echo "== Node（glibc）=="
if prun "command -v node >/dev/null 2>&1"; then
  ok "node 已存在: $(prun 'node -v' 2>/dev/null)"
else
  prun "apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg" || bad "apt 基础包安装失败"
  prun "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -" || bad "NodeSource 脚本失败"
  prun "apt-get install -y -qq nodejs" || bad "nodejs 安装失败"
  prun "command -v node >/dev/null 2>&1" && ok "node: $(prun 'node -v')" || bad "node 仍不可用"
fi

echo
echo "== 编译依赖 =="
prun "command -v gcc >/dev/null 2>&1" || prun "apt-get install -y -qq build-essential" || bad "build-essential 安装失败"

echo
echo "== 引擎 =="
if prun "test -f /usr/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js"; then
  ok "dsh 已安装"
else
  prun "npm i -g @deepseek-ai/dsh@${DSH_VER} --no-audit --no-fund" && ok "dsh ${DSH_VER} 安装完成" || bad "dsh 安装失败（检查网络/镜像）"
fi

echo
echo "== C 适配层 =="
if [ -d "$SRC" ]; then
  prun "mkdir -p /usr/local/bin /usr/local/lib"
  # 通过 bind 把宿主的源码目录带进来编译（避免 cp 之后再出错源）
  "$PROOT" --kill-on-exit -r "$ROOT" -b /dev -b /proc -b /sys -b "$SRC:/opt/jni" -w /opt/jni \
    /usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin \
    /bin/sh -lc '
      gcc -O2 -o /usr/local/bin/boo-sandbox-run boo-sandbox-run.c &&
      gcc -O2 -shared -fPIC -o /usr/local/lib/libboosandbox.so boosandbox.c -ldl &&
      gcc -O2 -shared -fPIC -o /usr/local/lib/liblinkcompat.so linkcompat.c -ldl
    ' && ok "三个 C 产物编译完成" || bad "C 产物编译失败（看上面的 gcc 输出）"
else
  bad "缺源码目录 $SRC（App 应从 assets/jni 复制三个 .c 到这里）"
fi

echo
echo "== 自检 =="
PLATFORM="$(prun 'node -e "console.log(process.platform)"' 2>/dev/null)"
[ "$PLATFORM" = "linux" ] && ok "process.platform=linux" || bad "process.platform=$PLATFORM（装了 bionic 版 node？）"
for f in /usr/local/bin/boo-sandbox-run /usr/local/lib/libboosandbox.so /usr/local/lib/liblinkcompat.so; do
  prun "test -f $f" && ok "$f" || bad "缺 $f"
done

echo
if [ "$FAILED" = "0" ]; then
  echo "装配完成。下一步：settings 里切到 proot 宿主，或直接跑 tools/verify-c.sh"
  exit 0
else
  echo "装配未完成，见上面 ❌ 项。"
  exit 2
fi