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
  export PATH="$W/node/bin:$PATH"
  export npm_config_registry="${NPM_REGISTRY:-https://registry.npmjs.org}"
  # 交叉装：runner 是 x86_64，但镜像要吃 arm64 的原生件
  export npm_config_arch=arm64
  export npm_config_platform=linux
  npm install -g "@deepseek-ai/dsh@$DSH_VER" \
    --prefix "$W/ubuntu-noble-aarch64/usr/local" \
    --cpu=arm64 --os=linux \
    --no-audit --no-fund \
    --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
  "$W/ubuntu-noble-aarch64/usr/local/bin/node" -v
  tar -cJf "$LAYER1" -C "$W" ubuntu-noble-aarch64
fi

ls -la "$LAYER0" "$LAYER1"
echo "layers ready"
