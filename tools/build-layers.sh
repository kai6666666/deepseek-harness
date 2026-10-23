#!/usr/bin/env bash
# 构建 APK 需要的两层镜像（CI 用；本地跑也可以）
#   layer0：Ubuntu 24.04 rootfs（直接从 OperitTerminalCore 拉）
#   layer1：node 24.19.0 + dsh 0.2.1-rc.2（本机装好后打包）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/app/src/main/assets"
NODE_VER="${NODE_VER:-24.19.0}"
DSH_VER="${DSH_VER:-0.2.1-rc.2}"
mkdir -p "$ASSETS"

LAYER0="$ASSETS/layer0-ubuntu-noble-aarch64.tar.xz"
LAYER1="$ASSETS/layer1-dsh-node${NODE_VER}-dsh${DSH_VER}.tar.xz"

if [ ! -f "$LAYER0" ]; then
  echo "[layer0] 下载 Ubuntu rootfs"
  curl -fL --retry 3 -o "$LAYER0" \
    https://raw.githubusercontent.com/AAswordman/OperitTerminalCore/master/src/main/assets/ubuntu-noble-aarch64-pd-v4.18.0.tar.xz
fi

if [ ! -f "$LAYER1" ]; then
  echo "[layer1] node $NODE_VER + dsh $DSH_VER"
  W="$(mktemp -d)"
  trap 'rm -rf "$W"' EXIT
  mkdir -p "$W/ubuntu-noble-aarch64/usr/local"
  curl -fL --retry 3 -o "$W/node.tar.xz" "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-arm64.tar.xz"
  mkdir -p "$W/node"
  tar -xJf "$W/node.tar.xz" -C "$W/node" --strip-components=1
  cp -a "$W/node/bin" "$W/node/lib" "$W/node/include" "$W/node/share" "$W/ubuntu-noble-aarch64/usr/local/"
  # 注意：镜像里放的是 arm64 node，但跑 npm 的是 runner 自己的 x86_64 node
  # （arm64 二进制在 x86 上根本执行不了）。npm 只负责落文件，交叉靠 --cpu/--os。
  export npm_config_registry="${NPM_REGISTRY:-https://registry.npmjs.org}"
  export npm_config_arch=arm64
  export npm_config_platform=linux
  npm install -g "@deepseek-ai/dsh@$DSH_VER" \
    --prefix "$W/ubuntu-noble-aarch64/usr/local" \
    --cpu=arm64 --os=linux \
    --no-audit --no-fund \
    --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
  # 不能在 x86 runner 上执行 arm64 的 node；只做结构 + ELF 机器类型校验
  test -x "$W/ubuntu-noble-aarch64/usr/local/bin/node"
  node -e "const b=require('fs').readFileSync(process.argv[1]);if(b.readUInt16LE(0x12)!==0xB7){console.error('not aarch64');process.exit(1)};console.log('node ELF machine = aarch64 OK')" "$W/ubuntu-noble-aarch64/usr/local/bin/node"
  test -f "$W/ubuntu-noble-aarch64/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json"
  tar -cJf "$LAYER1" -C "$W" ubuntu-noble-aarch64
fi

ls -la "$LAYER0" "$LAYER1"
echo "layers ready"
