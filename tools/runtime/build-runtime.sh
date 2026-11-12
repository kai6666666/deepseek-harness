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
ABI=${ABI:-arm64-v8a}

# ABI -> 平台三元组。x86_64 只用于模拟器（S4.5），发布仍只发 arm64。
case "$ABI" in
  arm64-v8a)
    UBUNTU_ARCH=arm64; NODE_ARCH=arm64; DEB_ARCH=aarch64; DEFAULT_CC=aarch64-linux-gnu-gcc
    NODE_OS_TAG=linux-arm64; NPM_CPU=arm64; NPM_ARCH=arm64
    _PROOT_SHA=10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030
    _TALLOC_SHA=556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7
    _SHMEM_SHA=0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6
    ;;
  x86_64)
    UBUNTU_ARCH=amd64; NODE_ARCH=x64; DEB_ARCH=x86_64; DEFAULT_CC=gcc
    NODE_OS_TAG=linux-x64; NPM_CPU=x64; NPM_ARCH=x64
    _PROOT_SHA=2497064226c15971be8131c7facead94a06c225347796326a383c832dca57758
    _TALLOC_SHA=b8c6d95f20075dc1f9ec6573575b2444e8d526e48e0d8d6d5cf4e071e6e06530
    _SHMEM_SHA=ffa9e4c87467b158b148d0ff92dda796aa038276c2075af3269cdcdb06f25797
    ;;
  *) echo "[rt][ERROR] 不支持的 ABI: $ABI" >&2; exit 2 ;;
esac

DSH_VERSION=${DSH_VERSION:-0.2.2-rc.1}
NODE_VERSION=${NODE_VERSION:-24.22.1}
UBUNTU_VERSION=${UBUNTU_VERSION:-24.04.5}
PROOT_VERSION=${PROOT_VERSION:-5.1.107.102}
TALLOC_VERSION=${TALLOC_VERSION:-2.5.0}
SHMEM_VERSION=${SHMEM_VERSION:-0.7}
PROOT_SHA=${PROOT_SHA:-$_PROOT_SHA}
TALLOC_SHA=${TALLOC_SHA:-$_TALLOC_SHA}
SHMEM_SHA=${SHMEM_SHA:-$_SHMEM_SHA}
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1767225600}
# 交叉编译：CI 上是 aarch64-linux-gnu-gcc；设备/arm64 主机上就是 gcc
CC=${CC:-$DEFAULT_CC}

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
UBUNTU_TAR=$UBUNTU_DIR/ubuntu-base-${UBUNTU_VERSION}-base-${UBUNTU_ARCH}.tar.gz
fetch "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-${UBUNTU_VERSION}-base-${UBUNTU_ARCH}.tar.gz" "$UBUNTU_TAR"
fetch "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/SHA256SUMS" "$UBUNTU_DIR/SHA256SUMS"
want_ubuntu=$(grep "ubuntu-base-${UBUNTU_VERSION}-base-${UBUNTU_ARCH}.tar.gz" "$UBUNTU_DIR/SHA256SUMS" | awk '{print $1}')
[ "$(sha256sum "$UBUNTU_TAR" | cut -d' ' -f1)" = "$want_ubuntu" ] || die "ubuntu-base sha256 不符"

NODE_TAR=$CACHE/node/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
fetch "https://npmmirror.com/mirrors/node/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" "$NODE_TAR"
fetch "https://npmmirror.com/mirrors/node/v$NODE_VERSION/SHASUMS256.txt" "$CACHE/node/v$NODE_VERSION/SHASUMS256.txt"
want_node=$(grep "node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" "$CACHE/node/v$NODE_VERSION/SHASUMS256.txt" | awk '{print $1}')
[ "$(sha256sum "$NODE_TAR" | cut -d' ' -f1)" = "$want_node" ] || die "node sha256 不符"

DEB_DIR=$CACHE/termux
PROOT_DEB=$DEB_DIR/proot_${PROOT_VERSION}_${DEB_ARCH}.deb
TALLOC_DEB=$DEB_DIR/libtalloc_${TALLOC_VERSION}_${DEB_ARCH}.deb
SHMEM_DEB=$DEB_DIR/libandroid-shmem_${SHMEM_VERSION}_${DEB_ARCH}.deb
fetch "https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_${PROOT_VERSION}_${DEB_ARCH}.deb" "$PROOT_DEB" "$PROOT_SHA"
fetch "https://packages.termux.dev/apt/termux-main/pool/main/libt/libtalloc/libtalloc_${TALLOC_VERSION}_${DEB_ARCH}.deb" "$TALLOC_DEB" "$TALLOC_SHA"
fetch "https://packages.termux.dev/apt/termux-main/pool/main/liba/libandroid-shmem/libandroid-shmem_${SHMEM_VERSION}_${DEB_ARCH}.deb" "$SHMEM_DEB" "$SHMEM_SHA"

# ---------- 2. jniLibs 四件套 ----------
rm -rf "$WORK/deb" "$JNI"
for d in "$PROOT_DEB" "$TALLOC_DEB" "$SHMEM_DEB"; do
  n=$(basename "$d" _${DEB_ARCH}.deb)
  mkdir -p "$WORK/deb/$n"
  dpkg-deb -x "$d" "$WORK/deb/$n"
done
mkdir -p "$JNI"
TERMUX_USR=$WORK/deb/proot_${PROOT_VERSION}/data/data/com.termux/files/usr
# ⚠️ 不要 patchelf 改 proot 的 DT_NEEDED：LDPlayer x86_64 实测，改过的 proot
# 在 --version 阶段就 SIGSEGV（原版 proot + 同一个 libtalloc 正常）。
# Android 只抽取 lib*.so，所以 libtalloc.so.2 / libandroid-shmem.so 作为
# **assets 原样**下发，ProotHost 解到 files/proot-libs 并放进 LD_LIBRARY_PATH。
cp "$TERMUX_USR/bin/proot"            "$JNI/libproot.so"
cp "$TERMUX_USR/libexec/proot/loader" "$JNI/libproot-loader.so"
chmod 755 "$JNI/libproot.so" "$JNI/libproot-loader.so"
log "jniLibs: $(ls -l "$JNI" | awk 'NR>1{printf "%s=%s ", $9, $5}')"
# 产物侧也放一份，App 的 jniLibs 直接指向这里
OUT_JNI=$OUT/$ABI/jniLibs/$ABI
mkdir -p "$OUT_JNI"
cp "$JNI"/*.so "$OUT_JNI"/

# proot 运行期库：保持 deb 里的原名（libtalloc.so.2），由 ProotHost 解到
# files/proot-libs 并放进 LD_LIBRARY_PATH。patchelf 改名会把这个 bionic
# 二进制改坏（LDPlayer x86_64 实测 SIGSEGV）。
PROOT_LIBS=$OUT/$ABI/assets/runtime/proot-libs
mkdir -p "$PROOT_LIBS"
cp "$WORK/deb/libtalloc_${TALLOC_VERSION}/data/data/com.termux/files/usr/lib/libtalloc.so.2.5.0" "$PROOT_LIBS/libtalloc.so.2"
cp "$WORK/deb/libandroid-shmem_${SHMEM_VERSION}/data/data/com.termux/files/usr/lib/libandroid-shmem.so" "$PROOT_LIBS/libandroid-shmem.so"
chmod 644 "$PROOT_LIBS/libtalloc.so.2" "$PROOT_LIBS/libandroid-shmem.so"
log "proot-libs: $(ls -l "$PROOT_LIBS" | awk 'NR>1{printf "%s=%s ", $9, $5}')"

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
  log "npm install @deepseek-ai/dsh@$DSH_VERSION ($NODE_OS_TAG, ignore-scripts)"
  (
    cd "$ROOTFS/opt/dsh"
    [ -f package.json ] || npm init -y >/dev/null 2>&1
    install_engine() {
      local reg=$1 extra=$2
      npm_config_platform=linux npm_config_os=linux npm_config_cpu=$NPM_CPU npm_config_arch=$NPM_ARCH \
        npm_config_cache="$CACHE/npm" \
        npm_config_registry="$reg" \
        npm install --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error $extra \
        "@deepseek-ai/dsh@$DSH_VERSION"
    }
    ok=0
    for reg in "${DSH_RT_NPM_REGISTRY:-https://registry.npmmirror.com}" https://registry.npmjs.org; do
      log "npm install via $reg"
      if install_engine "$reg" ""; then ok=1; break; fi
      log "registry 失败，换下一个：$reg"
    done
    if [ "$ok" != "1" ]; then
      log "registry 全失败，回退离线缓存"
      install_engine "https://registry.npmjs.org" "--offline" || die "npm install 失败（含离线回退）"
    fi
    node -e "const p=require('./node_modules/@deepseek-ai/dsh/package.json'); if(p.version!=='$DSH_VERSION'){console.error('version mismatch',p.version);process.exit(1)}; console.log('engine ok',p.version)"

    # 官方 linux-arm64 预编译（--ignore-scripts 不会装 optionalDependencies）
    NAS_VER=$(node -p "require('./node_modules/@deepseek-ai/node-addon-system/package.json').version")
    SHARP_VER=$(node -p "require('./node_modules/sharp/package.json').version")
    VIPS_VER=$(node -p "require('./node_modules/sharp/package.json').optionalDependencies['@img/sharp-libvips-$NODE_OS_TAG']")
    log "optional: node-addon-system-$NODE_OS_TAG@$NAS_VER sharp-$NODE_OS_TAG@$SHARP_VER libvips@$VIPS_VER"
    npm_config_os=linux npm_config_cpu=$NPM_CPU npm_config_arch=$NPM_ARCH \
      npm_config_cache="$CACHE/npm" npm install --no-save --force --ignore-scripts --no-audit --no-fund \
      "@deepseek-ai/node-addon-system-$NODE_OS_TAG@$NAS_VER" \
      "@img/sharp-$NODE_OS_TAG@$SHARP_VER" \
      "@img/sharp-libvips-$NODE_OS_TAG@$VIPS_VER" >/dev/null

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
  "$CC" -O2 -o "$ROOTFS/usr/local/bin/boo-sandbox-run"                "$SRCC/app/src/main/jni/boo-sandbox-run.c"
  "$CC" -O2 -shared -fPIC -o "$ROOTFS/usr/local/lib/libboosandbox.so" "$SRCC/app/src/main/jni/boosandbox.c" -ldl
  "$CC" -O2 -shared -fPIC -o "$ROOTFS/usr/local/lib/liblinkcompat.so" "$SRCC/app/src/main/jni/linkcompat.c" -ldl
  chmod 755 "$ROOTFS/usr/local/bin/boo-sandbox-run"
  chmod 644 "$ROOTFS/usr/local/lib/libboosandbox.so" "$ROOTFS/usr/local/lib/liblinkcompat.so"
  log "C layers: $(ls -l "$ROOTFS/usr/local/bin/boo-sandbox-run" "$ROOTFS/usr/local/lib"/*.so | awk '{printf "%s=%s ", $9, $5}')"
else
  log "跳过 C 层（缺 app/src/main/jni）"
fi

# ---------- 3.45 平台裁剪（只留 $NODE_OS_TAG） ----------
# npm 会把 node-pty 的全平台 prebuilds、win32/darwin 平台包一起装进来；
# 它们不是 AArch64，进 APK 既浪费体积又会被 verify.py 拦下。
if [ -d "$ROOTFS/opt/dsh/node_modules" ]; then
  find "$ROOTFS/opt/dsh/node_modules" -type d -name prebuilds -print0 2>/dev/null |
    while IFS= read -r -d '' d; do
      find "$d" -mindepth 1 -maxdepth 1 -type d ! -name "$NODE_OS_TAG" -exec rm -rf {} + 2>/dev/null || true
    done
  # ⚠️ 只删平台专属的**原生**包。JS 包必须留：subprocess-local 与
  # sandbox-windows-acl 在 linux 上也会静态 import @deepseek-ai/dsh-win32-process，
  # 删了会让 subprocess / sandbox 两个服务在启动时 failed to import（AVD 实测）。
  if [ -d "$ROOTFS/opt/dsh/node_modules/@img" ]; then
    find "$ROOTFS/opt/dsh/node_modules/@img" -mindepth 1 -maxdepth 1 -type d \
      ! -name "sharp-$NODE_OS_TAG" ! -name "sharp-libvips-$NODE_OS_TAG" \
      -exec rm -rf {} + 2>/dev/null || true
  fi
  if [ -d "$ROOTFS/opt/dsh/node_modules/@deepseek-ai" ]; then
    find "$ROOTFS/opt/dsh/node_modules/@deepseek-ai" -mindepth 1 -maxdepth 1 -type d \
      -name 'node-addon-system-*' ! -name "node-addon-system-$NODE_OS_TAG" \
      -exec rm -rf {} + 2>/dev/null || true
  fi
fi

# 去 setuid/setgid：Ubuntu base 自带 chfn/chsh/passwd/su/mount 等 setuid 程序。
# 它们落在 app 私有目录，setuid 本来就不生效；去掉位既能通过 verify，也少一个被误用的入口。
find "$ROOTFS" -perm /6000 -exec chmod a-s {} + 2>/dev/null || true

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
INPUTS=$( { cat "$0"; sha256sum "$PROOT_DEB" "$TALLOC_DEB" "$SHMEM_DEB" "$NODE_TAR" "$UBUNTU_TAR"; find "$REPO_ROOT/runtime/patches" -type f -print0 | sort -z | xargs -0 sha256sum; } | sha256sum | cut -c1-12 )
RUNTIME_VERSION="r1-$ABI-dsh${DSH_VERSION}-node${NODE_VERSION}-ubuntu${UBUNTU_VERSION}-${INPUTS}"

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
    "HOME=/root", "USER=root", "LOGNAME=root", "SHELL=/bin/bash", "DSH_HOME=/root/.dsh",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG=C.UTF-8", "TERM=xterm-256color", "TMPDIR=/tmp",
    "NODE_OPTIONS=--dns-result-order=ipv4first", "NODE_PATH=/opt/dsh/node_modules",
    "{GUEST_ENV}",
    "/bin/sh", "-c",
    "echo $$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web {PATCHES} --host 127.0.0.1 --port {PORT} --no-open",
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
