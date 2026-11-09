#!/usr/bin/env bash
# 构建单运行时（PRoot/glibc）资产：rootfs-arm64.tar.xz + manifest.json + jniLibs 四件套
#
# 用法：
#   tools/runtime/build-runtime.sh                 # 全量（arm64）
#   DSH_RT_SKIP_ENGINE=1 tools/runtime/build-runtime.sh   # 只做 base+node（快速自检）
#   DSH_RT_OUT=/path tools/runtime/build-runtime.sh
#
# 约定：
#   · 组装必须在 ext4 上做（/root 或 CI runner）；/sdcard 是 FUSE，不能建符号链接
#   · 产物只写 $DSH_RT_OUT（默认 <repo>/_build/runtime/out）
#   · 所有下载都校验 sha256；Ubuntu/Node 走官方 SHA256SUMS，Termux deb 走脚本内固定值
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
ABI=arm64-v8a

DSH_VERSION=${DSH_VERSION:-0.2.2-rc.1}
NODE_VERSION=${NODE_VERSION:-24.22.1}
UBUNTU_VERSION=${UBUNTU_VERSION:-24.04.5}
PROOT_VERSION=${PROOT_VERSION:-5.1.107.102}
TALLOC_VERSION=${TALLOC_VERSION:-2.5.0}
SHMEM_VERSION=${SHMEM_VERSION:-0.7}
PROOT_SHA=${PROOT_SHA:-10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030}
TALLOC_SHA=${TALLOC_SHA:-556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7}
SHMEM_SHA=${SHMEM_SHA:-0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6}
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1767225600}

WORK=${DSH_RT_WORK:-/root/dsh-runtime-build}
CACHE=${DSH_RT_CACHE:-/root/.cache/dsh-runtime}
OUT=${DSH_RT_OUT:-$REPO_ROOT/_build/runtime/out}
ROOTFS=$WORK/rootfs
JNI=$WORK/jni/$ABI

log() { printf '[rt] %s\n' "$*" >&2; }
die() { printf '[rt][ERROR] %s\n' "$*" >&2; exit 1; }

for t in curl tar xz python3 sha256sum patchelf readelf; do
  command -v "$t" >/dev/null || die "缺少工具：$t"
done

fetch() { # url dest [sha]
  local url=$1 dest=$2 want=${3:-}
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ]; then
    if [ -z "$want" ] || [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$want" ]; then
      log "cached: $(basename "$dest")"; return 0
    fi
    rm -f "$dest"
  fi
  log "download: $url"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
  if [ -n "$want" ]; then
    local got; got=$(sha256sum "$dest" | cut -d' ' -f1)
    [ "$got" = "$want" ] || { rm -f "$dest"; die "sha256 不符：$dest got=$got want=$want"; }
  fi
}

# ---------- 1. 下载 ----------
UBUNTU_DIR=$CACHE/ubuntu/$UBUNTU_VERSION
UBUNTU_TAR=$UBUNTU_DIR/ubuntu-base-${UBUNTU_VERSION}-base-arm64.tar.gz
fetch "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-${UBUNTU_VERSION}-base-arm64.tar.gz" "$UBUNTU_TAR"
fetch "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/SHA256SUMS" "$UBUNTU_DIR/SHA256SUMS"
want_ubuntu=$(grep "ubuntu-base-${UBUNTU_VERSION}-base-arm64.tar.gz" "$UBUNTU_DIR/SHA256SUMS" | awk '{print $1}')
[ "$(sha256sum "$UBUNTU_TAR" | cut -d' ' -f1)" = "$want_ubuntu" ] || die "ubuntu-base sha256 不符"

NODE_TAR=$CACHE/node/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz
fetch "https://npmmirror.com/mirrors/node/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" "$NODE_TAR"
fetch "https://npmmirror.com/mirrors/node/v$NODE_VERSION/SHASUMS256.txt" "$CACHE/node/v$NODE_VERSION/SHASUMS256.txt"
want_node=$(grep "node-v$NODE_VERSION-linux-arm64.tar.xz" "$CACHE/node/v$NODE_VERSION/SHASUMS256.txt" | awk '{print $1}')
[ "$(sha256sum "$NODE_TAR" | cut -d' ' -f1)" = "$want_node" ] || die "node sha256 不符"

DEB_DIR=$CACHE/termux
PROOT_DEB=$DEB_DIR/proot_${PROOT_VERSION}_aarch64.deb
TALLOC_DEB=$DEB_DIR/libtalloc_${TALLOC_VERSION}_aarch64.deb
SHMEM_DEB=$DEB_DIR/libandroid-shmem_${SHMEM_VERSION}_aarch64.deb
fetch "https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_${PROOT_VERSION}_aarch64.deb" "$PROOT_DEB" "$PROOT_SHA"
fetch "https://packages.termux.dev/apt/termux-main/pool/main/libt/libtalloc/libtalloc_${TALLOC_VERSION}_aarch64.deb" "$TALLOC_DEB" "$TALLOC_SHA"
fetch "https://packages.termux.dev/apt/termux-main/pool/main/liba/libandroid-shmem/libandroid-shmem_${SHMEM_VERSION}_aarch64.deb" "$SHMEM_DEB" "$SHMEM_SHA"

# ---------- 2. jniLibs 四件套 ----------
rm -rf "$WORK/deb" "$JNI"
for d in "$PROOT_DEB" "$TALLOC_DEB" "$SHMEM_DEB"; do
  n=$(basename "$d" _aarch64.deb)
  mkdir -p "$WORK/deb/$n"
  dpkg-deb -x "$d" "$WORK/deb/$n"
done
mkdir -p "$JNI"
TERMUX_USR=$WORK/deb/proot_${PROOT_VERSION}/data/data/com.termux/files/usr
cp "$TERMUX_USR/bin/proot"            "$JNI/libproot.so"
cp "$TERMUX_USR/libexec/proot/loader" "$JNI/libproot-loader.so"
cp "$WORK/deb/libtalloc_${TALLOC_VERSION}/data/data/com.termux/files/usr/lib/libtalloc.so.2.5.0" "$JNI/libtalloc.so"
cp "$WORK/deb/libandroid-shmem_${SHMEM_VERSION}/data/data/com.termux/files/usr/lib/libandroid-shmem.so" "$JNI/libandroid-shmem.so"
chmod 755 "$JNI/libproot.so" "$JNI/libproot-loader.so"

# Android 只抽取 lib*.so；libtalloc.so.2 必须改名并把 DT_NEEDED 一起改掉
patchelf --replace-needed libtalloc.so.2 libtalloc.so "$JNI/libproot.so"
readelf -d "$JNI/libproot.so" | grep -q 'libtalloc.so' || die "DT_NEEDED 未改成功"
log "jniLibs: $(ls -l "$JNI" | awk 'NR>1{printf "%s=%s ", $9, $5}')"
# 产物侧也放一份，App 的 jniLibs 直接指向这里
OUT_JNI=$OUT/$ABI/jniLibs/$ABI
mkdir -p "$OUT_JNI"
cp "$JNI"/*.so "$OUT_JNI"/

# ---------- 3. rootfs ----------
rm -rf "$ROOTFS"
mkdir -p "$ROOTFS"
python3 "$HERE/extract.py" "$UBUNTU_TAR" "$ROOTFS" 0
python3 "$HERE/extract.py" "$NODE_TAR" "$ROOTFS/usr" 1
# node 官方 tarball 带 ~85 MB 头文件与文档，运行时用不到
rm -rf "$ROOTFS/usr/include/node" "$ROOTFS/usr/share/doc" "$ROOTFS/usr/share/man" \
       "$ROOTFS/usr/lib/node_modules/npm/docs" 2>/dev/null || true
mkdir -p "$ROOTFS"/root/.l2s "$ROOTFS"/var/lib/dsh-app/empty "$ROOTFS"/var/lib/dsh-app/shm \
         "$ROOTFS"/opt/dsh "$ROOTFS"/usr/local/bin "$ROOTFS"/usr/local/lib
ln -sf /usr/bin/node "$ROOTFS/usr/local/bin/node"
ln -sf /usr/bin/npm  "$ROOTFS/usr/local/bin/npm" 2>/dev/null || true
cat > "$ROOTFS/usr/local/bin/dsh" <<'SH'
#!/bin/sh
exec /usr/local/bin/node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
SH
chmod 755 "$ROOTFS/usr/local/bin/dsh"

if [ "${DSH_RT_SKIP_ENGINE:-0}" != "1" ]; then
  log "npm install @deepseek-ai/dsh@$DSH_VERSION (linux/arm64, ignore-scripts)"
  (
    cd "$ROOTFS/opt/dsh"
    [ -f package.json ] || npm init -y >/dev/null 2>&1
    npm_config_platform=linux npm_config_arch=arm64 npm_config_cache="$CACHE/npm" \
      npm install --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error \
      "@deepseek-ai/dsh@$DSH_VERSION"
    node -e "const p=require('./node_modules/@deepseek-ai/dsh/package.json'); if(p.version!=='$DSH_VERSION'){console.error('version mismatch',p.version);process.exit(1)}; console.log('engine ok',p.version)"

    # 官方 linux-arm64 预编译（--ignore-scripts 不会装 optionalDependencies）
    NAS_VER=$(node -p "require('./node_modules/@deepseek-ai/node-addon-system/package.json').version")
    SHARP_VER=$(node -p "require('./node_modules/sharp/package.json').version")
    VIPS_VER=$(node -p "require('./node_modules/sharp/package.json').optionalDependencies['@img/sharp-libvips-linux-arm64']")
    log "optional: node-addon-system-linux-arm64@$NAS_VER sharp-linux-arm64@$SHARP_VER libvips@$VIPS_VER"
    npm_config_cache="$CACHE/npm" npm install --no-save --force --ignore-scripts --no-audit --no-fund \
      "@deepseek-ai/node-addon-system-linux-arm64@$NAS_VER" \
      "@img/sharp-linux-arm64@$SHARP_VER" \
      "@img/sharp-libvips-linux-arm64@$VIPS_VER" >/dev/null

    log "apply patches ($DSH_VERSION)"
    python3 "$REPO_ROOT/tools/runtime/apply-patches.py" \
      --prefix "$ROOTFS/opt/dsh" --dsh-version "$DSH_VERSION" \
      --patches "$REPO_ROOT/runtime/patches"
  )
else
  log "跳过引擎安装（DSH_RT_SKIP_ENGINE=1）"
fi

# ---------- 3.4 C 适配层（glibc 重编） ----------
JNI_SRC=$REPO_ROOT/app/src/main/jni
if [ -f "$JNI_SRC/boo-sandbox-run.c" ]; then
  SRCC=$WORK/glibc-src
  rm -rf "$SRCC"
  mkdir -p "$SRCC/app/src/main/jni" "$SRCC/tools"
  cp "$JNI_SRC"/*.c "$SRCC/app/src/main/jni/"
  cp "$REPO_ROOT/tools/apply-glibc-patches.py" "$SRCC/tools/"
  ( cd "$SRCC" && python3 tools/apply-glibc-patches.py )
  gcc -O2 -o "$ROOTFS/usr/local/bin/boo-sandbox-run"                  "$SRCC/app/src/main/jni/boo-sandbox-run.c"
  gcc -O2 -shared -fPIC -o "$ROOTFS/usr/local/lib/libboosandbox.so"   "$SRCC/app/src/main/jni/boosandbox.c" -ldl
  gcc -O2 -shared -fPIC -o "$ROOTFS/usr/local/lib/liblinkcompat.so"   "$SRCC/app/src/main/jni/linkcompat.c" -ldl
  chmod 755 "$ROOTFS/usr/local/bin/boo-sandbox-run"
  chmod 644 "$ROOTFS/usr/local/lib/libboosandbox.so" "$ROOTFS/usr/local/lib/liblinkcompat.so"
  log "C layers: $(ls -l "$ROOTFS/usr/local/bin/boo-sandbox-run" "$ROOTFS/usr/local/lib"/*.so | awk '{printf "%s=%s ", $9, $5}')"
else
  log "跳过 C 层（缺 app/src/main/jni）"
fi

# ---------- 3.5 瘦身（默认开；DSH_RT_PRUNE=0 关闭） ----------
if [ "${DSH_RT_PRUNE:-1}" = "1" ] && [ -d "$ROOTFS/opt/dsh/node_modules" ]; then
  log "prune: 删除 sourcemap / 测试 / 文档"
  find "$ROOTFS/opt/dsh/node_modules" -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) -delete
  find "$ROOTFS/opt/dsh/node_modules" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
fi

# ---------- 4. 打包 ----------
ASSET_DIR=$OUT/$ABI/assets/runtime
mkdir -p "$ASSET_DIR"
log "tar + xz（SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH）"
( cd "$ROOTFS" && tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --hard-dereference \
    -cf - . ) | xz -6e -T0 > "$ASSET_DIR/rootfs-$ABI.tar.xz"

# ---------- 5. manifest ----------
INPUTS=$( { cat "$0"; sha256sum "$PROOT_DEB" "$TALLOC_DEB" "$SHMEM_DEB" "$NODE_TAR" "$UBUNTU_TAR"; } | sha256sum | cut -c1-12 )
RUNTIME_VERSION="r1-dsh${DSH_VERSION}-node${NODE_VERSION}-ubuntu${UBUNTU_VERSION}-${INPUTS}"

ROOTFS_SHA=$(sha256sum "$ASSET_DIR/rootfs-$ABI.tar.xz" | cut -d' ' -f1)
ROOTFS_SIZE=$(stat -c%s "$ASSET_DIR/rootfs-$ABI.tar.xz")
JNI_JSON=$(cd "$JNI" && for f in *.so; do printf '"%s":{"sha256":"%s","bytes":%s},' "$f" "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c%s "$f")"; done | sed 's/,$//')

python3 - "$ASSET_DIR/manifest.json" "$RUNTIME_VERSION" "$ABI" "$ROOTFS_SHA" "$ROOTFS_SIZE" "$JNI_JSON" <<'PY'
import json, sys
out, ver, abi, sha, size, jni = sys.argv[1:7]
argv = [
    "{NATIVE_LIB_DIR}/libproot.so",
    "--kill-on-exit", "--link2symlink", "--sysvipc", "-L", "-0",
    "--rootfs={ROOTFS}", "--cwd=/root",
    "-b", "/dev", "-b", "/proc", "-b", "/sys", "-b", "/system", "-b", "/apex",
    "-b", "{ROOTFS}/var/lib/dsh-app/empty:/sys/fs/selinux",
    "-b", "{ROOTFS}/var/lib/dsh-app/shm:/dev/shm",
    "/usr/bin/env", "-i",
    "HOME=/root", "USER=root", "LOGNAME=root", "SHELL=/bin/bash",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG=C.UTF-8", "TERM=xterm-256color", "TMPDIR=/tmp",
    "NODE_OPTIONS=--dns-result-order=ipv4first", "NODE_PATH=/opt/dsh/node_modules",
    "{GUEST_ENV}",
    "/bin/sh", "-c",
    "echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --host 127.0.0.1 --port {PORT} --no-open",
]
m = {
    "runtimeVersion": ver,
    "abi": abi,
    "rootfs": {"asset": f"runtime/rootfs-{abi}.tar.xz", "sha256": sha, "bytes": int(size)},
    "jniLibs": json.loads("{" + jni + "}"),
    "launch": {
        "argv": argv,
        "env": {
            "PROOT_LOADER": "{NATIVE_LIB_DIR}/libproot-loader.so",
            "PROOT_TMP_DIR": "{TMP}",
            "PROOT_L2S_DIR": "{ROOTFS}/root/.l2s",
            "LD_LIBRARY_PATH": "{NATIVE_LIB_DIR}",
        },
        "placeholders": {
            "{NATIVE_LIB_DIR}": "applicationInfo.nativeLibraryDir（useLegacyPackaging=true）",
            "{ROOTFS}": "filesDir/runtime/rootfs",
            "{TMP}": "cacheDir/proot-tmp",
            "{PORT}": "App 选的回环端口",
            "{GUEST_ENV}": "独立元素：追加 0..N 个 KEY=VALUE",
        },
    },
    "tokenLine": {"regex": "^dsh web: (http://127\\.0\\.0\\.1:[0-9]+/)\\?token=([A-Za-z0-9_-]+)"},
    "health": {"tcp": True, "unauthStatus": 401, "authStatus": 200},
    "stop": {"pidFile": "{ROOTFS}/tmp/dsh-web.pid", "graceful": "SIGTERM node", "force": "SIGQUIT proot"},
    "files": {"dshHome": "/root/.dsh", "l2sDir": "{ROOTFS}/root/.l2s"},
}
json.dump(m, open(out, "w"), ensure_ascii=False, indent=2)
print("manifest", out)
PY

log "done"
log "rootfs:  $ASSET_DIR/rootfs-$ABI.tar.xz  $(numfmt --to=iec "$ROOTFS_SIZE")  sha256=$ROOTFS_SHA"
log "runtime: $RUNTIME_VERSION"
