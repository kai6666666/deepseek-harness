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

DSH_VERSION=${DSH_VERSION:-$(tr -d ' \r\n' < "$HERE/../engine-version.txt")}
NODE_VERSION=${NODE_VERSION:-24.22.1}
PNPM_VERSION=${PNPM_VERSION:-11.28.5}
CA_CERTS_VERSION=${CA_CERTS_VERSION:-20260816ubuntu0.24.04.2}
CA_CERTS_SHA=${CA_CERTS_SHA:-f9fbacd417b515450b831032cc39d18059e9874e67525679a43c16071dabf9a0}
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
CA_DEB=$CACHE/ubuntu/ca-certificates_${CA_CERTS_VERSION}_all.deb
fetch "http://ports.ubuntu.com/ubuntu-ports/pool/main/c/ca-certificates/ca-certificates_${CA_CERTS_VERSION}_all.deb" "$CA_DEB" "$CA_CERTS_SHA"

# ---------- 2. jniLibs 四件套 ----------
rm -rf "$WORK/deb" "$JNI"
for d in "$PROOT_DEB" "$TALLOC_DEB" "$SHMEM_DEB"; do
  n=$(basename "$d" _${DEB_ARCH}.deb)
  mkdir -p "$WORK/deb/$n"
  dpkg-deb -x "$d" "$WORK/deb/$n"
done
mkdir -p "$JNI"
TERMUX_USR=$WORK/deb/proot_${PROOT_VERSION}/data/data/com.termux/files/usr
TALLOC_USR=$WORK/deb/libtalloc_${TALLOC_VERSION}/data/data/com.termux/files/usr
SHMEM_USR=$WORK/deb/libandroid-shmem_${SHMEM_VERSION}/data/data/com.termux/files/usr
# ⚠️ 不要 patchelf 改 proot 的 DT_NEEDED：LDPlayer x86_64 实测，改过的 proot
# 在 --version 阶段就 SIGSEGV（原版 proot + 同一个 libtalloc 正常）。
#
# P1（0.3.0-refactor.1）：可执行体与它依赖的共享库**全部收进 jniLibs**，不再往
# assets 里放 proot-libs。做法不是 patchelf，而是**等长改写 .dynstr**：proot 的
# DT_NEEDED 是 dynstr 里的一个偏移，把 "libtalloc.so.2" 覆写成 "libtalloc.so\0\0"
# 后偏移不变、文件大小不变 ⇒ 不会像 patchelf 那样改坏它。
# Android 只抽取 lib*.so（且 extractNativeLibs/useLegacyPackaging 已开），
# 所以文件必须叫 libtalloc.so / libandroid-shmem.so。
cp "$TERMUX_USR/bin/proot"            "$JNI/libproot.so"
cp "$TERMUX_USR/libexec/proot/loader" "$JNI/libproot-loader.so"
cp "$TALLOC_USR/lib/libtalloc.so.2.5.0" "$JNI/libtalloc.so"
cp "$SHMEM_USR/lib/libandroid-shmem.so" "$JNI/libandroid-shmem.so"
python3 "$HERE/patch-dynstr.py" "$JNI/libproot.so" libtalloc.so.2 libtalloc.so
chmod 755 "$JNI/libproot.so" "$JNI/libproot-loader.so"
chmod 644 "$JNI/libtalloc.so" "$JNI/libandroid-shmem.so"

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

# 网络基础与 CA 根证书（ubuntu-base 默认 /etc/resolv.conf 与 /etc/hosts 为空，且无 ca-certificates）
printf 'nameserver 223.5.5.5
nameserver 119.29.29.29
nameserver 8.8.8.8
' > "$ROOTFS/etc/resolv.conf"
printf '127.0.0.1 localhost
::1 localhost
' > "$ROOTFS/etc/hosts"
dpkg-deb -x "$CA_DEB" "$ROOTFS"
mkdir -p "$ROOTFS/etc/ssl/certs"
cat "$ROOTFS"/usr/share/ca-certificates/mozilla/*.crt > "$ROOTFS/etc/ssl/certs/ca-certificates.crt"
chmod 644 "$ROOTFS/etc/ssl/certs/ca-certificates.crt"
# 让 OpenSSL / curl / python / git 按 hash 目录也能认出证书
if command -v openssl >/dev/null 2>&1; then
  ( cd "$ROOTFS/etc/ssl/certs" && for f in "$ROOTFS"/usr/share/ca-certificates/mozilla/*.crt; do
      b=$(basename "$f" .crt).pem
      ln -sf "/usr/share/ca-certificates/mozilla/$(basename "$f")" "$b"
    done && openssl rehash . >/dev/null 2>&1 || true )
fi

# ---------- 3.2 开发工具（git / python3 / curl） ----------
# 为什么预置：0.5.0 的救援与自愈都会**重新解包 rootfs**，而镜像外手工 apt 的东西
# 解包后就没了（S6 真机实测）。放进镜像才谈得上「修复后 dev-env 自动回来」。
#
# 做法：在构建机上直接 chroot 进目标 rootfs 跑 apt（arm64 垫一层 qemu-user）。
# 不走「apt-get download + 手工解包」：python3 的依赖闭包很深，手工拼必漏。
# ⚠️ GitHub runner 的构建步骤**不是 root**（实测 id -u != 0），所以这里用 sudo；
#    没有 sudo 又没有 root 时**必须 die**，不能静默跳过 —— 静默跳过会让
#    verify.py 的断言在出包末尾才炸，看起来像「断言写错了」。
if [ "${DSH_RT_DEV_TOOLS:-1}" = "1" ]; then
  SUDO=""
  if [ "$(id -u)" != "0" ]; then
    command -v sudo >/dev/null 2>&1 || die "dev 工具预置需要 root 或 sudo（可设 DSH_RT_DEV_TOOLS=0 跳过）"
    SUDO=sudo
  fi
  log "install dev tools: git / python3 / curl (apt in rootfs)"
  if [ "$ABI" != "x86_64" ]; then
    # 用 binfmt_misc（docker/setup-qemu-action 注册，带 F 标志）而不是把
    # qemu-*-static 拷进 rootfs：runner 的 apt 源里没有 qemu-user-static
    # （实测 `E: Package 'qemu-user-static' has no installation candidate`）。
    [ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ] \
      || die "缺少 binfmt qemu-aarch64：arm64 chroot 需要 docker/setup-qemu-action"
  fi
  $SUDO rm -f "$ROOTFS"/etc/apt/sources.list.d/*.sources 2>/dev/null || true
  # ⚠️ ports.ubuntu.com 只有 non-amd64 的包；x86_64 rootfs 必须走 archive.ubuntu.com，
  #    否则 apt 会拿 arm64 索引去满足 amd64 依赖（实测退出码 100）。
  if [ "$ABI" = "x86_64" ]; then APT_HOST=archive.ubuntu.com; APT_SUITE=noble
  else APT_HOST=ports.ubuntu.com; APT_SUITE=noble; fi
  if [ "$APT_HOST" = "ports.ubuntu.com" ]; then APT_URI="http://$APT_HOST/ubuntu-ports"
  else APT_URI="http://$APT_HOST/ubuntu"; fi
  printf 'deb %s %s main universe\ndeb %s %s-updates main universe\ndeb %s %s-security main universe\n' \
    "$APT_URI" "$APT_SUITE" "$APT_URI" "$APT_SUITE" "$APT_URI" "$APT_SUITE" \
    | $SUDO tee "$ROOTFS/etc/apt/sources.list" >/dev/null
  $SUDO cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf"
  # chroot 里没有 /dev、/proc 时 apt-key 连 /dev/null 都写不了（实测报
  # `cannot create /dev/null: Permission denied`），必须先把宿主的两棵树挂进去。
  $SUDO mount --bind /dev "$ROOTFS/dev" 2>/dev/null || true
  $SUDO mount -t proc proc "$ROOTFS/proc" 2>/dev/null || true
  # ubuntu-base 没带 gpgv/ubuntu-keyring ⇒ 源签名验不了；这里放行未签名仓库，
  # 而三个可执行文件的存在性由 verify.py 硬断言兜底。
  DEBIAN_FRONTEND=noninteractive $SUDO chroot "$ROOTFS" /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DEBIAN_FRONTEND=noninteractive \
    /bin/sh -c 'apt-get -o Acquire::AllowInsecureRepositories=true -o Acquire::AllowDowngradeToInsecureRepositories=true update -qq && apt-get install -y -qq --no-install-recommends --allow-unauthenticated git python3 curl ca-certificates' \
    || INSTALL_RC=$?
  # 版本检查必须在卸载 /dev、/proc **之前**（动态加载器要用 /dev/null）。
  DEV_VER=$($SUDO chroot "$ROOTFS" /usr/bin/git --version 2>/dev/null || echo '?')
  PY_VER=$($SUDO chroot "$ROOTFS" /usr/bin/python3 -V 2>/dev/null || echo '?')
  # ⚠️ 必须真卸载：`umount -l` 只把挂载点摘下来，tar 仍可能走进去（实测
  #    `tar: Exiting with failure status due to previous errors`）。
  for m in dev proc; do
    $SUDO umount "$ROOTFS/$m" 2>/dev/null || $SUDO umount -l "$ROOTFS/$m" 2>/dev/null || true
    if mountpoint -q "$ROOTFS/$m" 2>/dev/null; then die "$ROOTFS/$m 仍未卸载，拒绝打包"; fi
  done
  [ -z "${INSTALL_RC:-}" ] || die "dev 工具安装失败（rc=$INSTALL_RC）"
  $SUDO rm -rf "$ROOTFS"/var/lib/apt/lists/* "$ROOTFS"/var/cache/apt/archives/*.deb
  $SUDO rm -rf "$ROOTFS"/var/cache/ldconfig "$ROOTFS"/var/cache/debconf 2>/dev/null || true
  # apt 的二进制索引缓存（每个 50 MB 原始 / 11 MB xz，合计 22 MB = rootfs.tar.xz 的 12.4%）：
  # 纯垃圾，且每次重建都变 → 既白占体积，又让「引擎升级」的差异量虚高 100 MB。
  $SUDO rm -f "$ROOTFS"/var/cache/apt/pkgcache.bin "$ROOTFS"/var/cache/apt/srcpkgcache.bin 2>/dev/null || true
  # apt 落下的文件属于 root（/etc/ssl/private 是 0700），而后续打包以构建用户跑 tar，
  # 实测会 `Cannot open: Permission denied`。把整棵树交还构建用户。
  $SUDO chown -R "$(id -u):$(id -g)" "$ROOTFS"
  # apt 又把文档/手册装回来了（node 那一步清理在它之前），再清一遍省体积。
  $SUDO rm -rf "$ROOTFS/usr/share/doc" "$ROOTFS/usr/share/man" "$ROOTFS/usr/share/info" 2>/dev/null || true
  $SUDO find "$ROOTFS/usr/lib/python3.12" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
  for b in git python3 curl; do
    [ -x "$ROOTFS/usr/bin/$b" ] || die "dev 工具缺失: /usr/bin/$b"
  done
  # ⚠️ 上面为了 chroot apt 临时 `cp /etc/resolv.conf` 进来，那份是**构建机**的
  #    systemd-resolved 桩（`nameserver 127.0.0.53` + `search *.compute.internal`）。
  #    手机上没有 127.0.0.53，带进镜像就是「所有域名都解析不了」——
  #    真机症状：登录/插件市场全 `no-response`、market 回落到离线目录（2026-11-15 实测）。
  #    必须还原成 §3 里写的那份公共 DNS。
  printf 'nameserver 223.5.5.5\nnameserver 119.29.29.29\nnameserver 8.8.8.8\n' \
    | $SUDO tee "$ROOTFS/etc/resolv.conf" >/dev/null
  log "dev tools: $DEV_VER / $PY_VER"
fi

# 预装 pnpm 到 /usr/local（独立 prefix，不污染 /opt/dsh，离线可用）
log "install pnpm@$PNPM_VERSION -> /usr/local"
ok_pnpm=0
for reg in "${DSH_RT_NPM_REGISTRY:-https://registry.npmmirror.com}" https://registry.npmjs.org; do
  if npm_config_cache="$CACHE/npm" npm_config_registry="$reg" npm_config_prefix="$ROOTFS/usr/local"      npm install -g --no-audit --no-fund --ignore-scripts --loglevel=error "pnpm@$PNPM_VERSION"; then
    ok_pnpm=1; break
  fi
done
[ "$ok_pnpm" = "1" ] || npm_config_cache="$CACHE/npm" npm_config_prefix="$ROOTFS/usr/local"   npm install -g --offline --no-audit --no-fund --ignore-scripts --loglevel=error "pnpm@$PNPM_VERSION" || die "pnpm 安装失败"
[ -f "$ROOTFS/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs" ] || die "pnpm.cjs 未落盘"
ln -sf "../lib/node_modules/pnpm/bin/pnpm.cjs" "$ROOTFS/usr/local/bin/pnpm"
chmod 755 "$ROOTFS/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs"
# 裁剪 pnpm 里非当前平台（darwin / win32）的原生模块与 exe，避免 verify.py 拦截
# ⚠️ pnpm 10 把 reflink 放在 `dist/reflink.<os>-<arch>.node`；
#    pnpm 11 改成 `dist/node_modules/@reflink/reflink-<os>-<arch>/reflink.<os>-<arch>.node`。
#    两条路径都要清，否则 4 个 darwin/win32 的 .node（Mach-O/PE，e_machine=None）
#    会被 verify.py 判成「不是 AArch64」——CI 实测踩到（run 44143285309）。
PNPM_DIST="$ROOTFS/usr/local/lib/node_modules/pnpm/dist"
rm -f "$PNPM_DIST"/reflink.darwin-*.node "$PNPM_DIST"/reflink.win32-*.node "$PNPM_DIST"/vendor/*.exe 2>/dev/null || true
if [ -d "$PNPM_DIST/node_modules/@reflink" ]; then
  find "$PNPM_DIST/node_modules/@reflink" -mindepth 1 -maxdepth 1 -type d \
    ! -name 'reflink-linux-*' -exec rm -rf {} + 2>/dev/null || true
fi
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
      --prefix "$ROOTFS/opt/dsh" --dsh-version "$DSH_VERSION" --require-version \
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
  # ⚠️ 只删**平台专属的原生** @img 包。`@img/colour` 是纯 JS，却被 sharp 的
  # `dist/colour.cjs` 在 require 期无条件加载 —— 按「白名单只留 sharp-*」删会把它
  # 一起删掉，症状是 `Cannot find module '@img/colour'`，图片附件整条链路失败。
  if [ -d "$ROOTFS/opt/dsh/node_modules/@img" ]; then
    find "$ROOTFS/opt/dsh/node_modules/@img" -mindepth 1 -maxdepth 1 -type d \
      \( -name 'sharp-*' -o -name 'sharp-libvips-*' \) \
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
# P4-a′：glibc loader 也进 jniLibs（**必须放在这里**：109 行那段跑的时候 rootfs 还没解包）。
# 为什么：Android 10+ 不允许 untrusted_app execve app data 里的文件（vc93 真机 error=13）；
# nativeLibraryDir 是唯一保证可执行的位置。loader 是解释器：内核只 execve 它，node 由它 mmap。
GLIBC_LOADER="$ROOTFS/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"
if [ -f "$GLIBC_LOADER" ]; then
  cp "$GLIBC_LOADER" "$OUT_JNI/libld-linux.so"
  chmod 755 "$OUT_JNI/libld-linux.so"
  log "direct loader -> $OUT_JNI/libld-linux.so ($(wc -c < "$OUT_JNI/libld-linux.so") B)"
else
  log "⚠️ 没找到 $GLIBC_LOADER，direct 直启不可用（降级 proot）"
fi

# ---------- 3.5 瘦身（默认开；DSH_RT_PRUNE=0 关闭） ----------
if [ "${DSH_RT_PRUNE:-1}" = "1" ] && [ -d "$ROOTFS/opt/dsh/node_modules" ]; then
  log "prune: 删除 sourcemap / 测试 / 文档"
  # P3-bis：删类型声明与包内 TS 源（运行时只读 lib/*.js）。
  # 实测：.d.ts 16,196 个 / 51.3 MB；.ts 12,147 个 / 115.3 MB —— 占 node_modules 条目 37%。
  find "$ROOTFS/opt/dsh/node_modules" -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete 2>/dev/null || true
  find "$ROOTFS/opt/dsh/node_modules" -path '*/src/*' -type f -name '*.ts' -delete 2>/dev/null || true
  # ⚠️ **必须保留 README.md / readme.md**：
# `@deepseek-ai/dsh-plugin-detail` 只认这两个文件名；删掉之后（2026-11-23 实测）
# 每个插件的详情页都报「插件声明的详细介绍文件无效」，而包里的 README.i18n.yaml
# 只是双语区块哈希的旁签、没有正文，补救不了。体积代价约 1~2 MB。
find "$ROOTFS/opt/dsh/node_modules" -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) \
  ! -name 'README.md' ! -name 'readme.md' -delete
  find "$ROOTFS/opt/dsh/node_modules" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
fi

# ---------- 4. 打包 ----------
ASSET_DIR=$OUT/$ABI/assets/runtime
mkdir -p "$ASSET_DIR"
log "tar + xz 分片（SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH）"
# P3：按顶层目录切 4 片，运行期多线程并行解（单 tar 流顺序读，无法并行）。
#   part0 = ./opt（引擎，88% 条目）→ 文件名保持 rootfs-$ABI.tar.xz，verify.py / 旧路径零改动。
mkpart() {
  local name="$1"; shift
  local keep=()
  local p
  for p in "$@"; do [ -e "$ROOTFS/$p" ] && keep+=("$p"); done
  if [ "${#keep[@]}" -eq 0 ]; then
    ( cd "$ROOTFS" && tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --hard-dereference -cf - --files-from /dev/null ) | xz -6e -T0 > "$ASSET_DIR/$name"
    return 0
  fi
  ( cd "$ROOTFS" && tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --hard-dereference -cf - "${keep[@]}" ) | xz -6e -T0 > "$ASSET_DIR/$name"
}
mkpart "rootfs-$ABI.tar.xz" ./opt
mkpart "rootfs-part1-$ABI.tar.xz" ./usr
mkpart "rootfs-part2-$ABI.tar.xz" ./var ./etc
mkpart "rootfs-part3-$ABI.tar.xz" ./bin ./boot ./dev ./home ./lib ./media ./mnt ./proc ./root ./run ./sbin ./srv ./sys ./tmp ./lib64
ls -lh "$ASSET_DIR"/rootfs-*.tar.xz

# ---------- 5. manifest ----------
INPUTS=$( { cat "$0"; sha256sum "$PROOT_DEB" "$TALLOC_DEB" "$SHMEM_DEB" "$CA_DEB" "$NODE_TAR" "$UBUNTU_TAR"; find "$REPO_ROOT/runtime/patches" -type f -print0 | sort -z | xargs -0 sha256sum; } | sha256sum | cut -c1-12 )
RUNTIME_VERSION="r1-$ABI-dsh${DSH_VERSION}-node${NODE_VERSION}-ubuntu${UBUNTU_VERSION}-${INPUTS}"

# P3：分片清单（part0 在前；运行期据此并行解包）
PARTS_JSON=$(cd "$ASSET_DIR" && for f in "rootfs-$ABI.tar.xz" rootfs-part*-*.tar.xz; do
  [ -f "$f" ] || continue
  printf '{"asset":"runtime/%s","sha256":"%s","bytes":%s},' "$f" "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c%s "$f")"
done | sed 's/,$//')
log "runtime parts: $PARTS_JSON"
ROOTFS_SHA=$(sha256sum "$ASSET_DIR/rootfs-$ABI.tar.xz" | cut -d' ' -f1)
ROOTFS_SIZE=$(stat -c%s "$ASSET_DIR/rootfs-$ABI.tar.xz")
JNI_JSON=$(cd "$JNI" && for f in *.so; do printf '"%s":{"sha256":"%s","bytes":%s},' "$f" "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c%s "$f")"; done | sed 's/,$//')

python3 - "$ASSET_DIR/manifest.json" "$RUNTIME_VERSION" "$ABI" "$ROOTFS_SHA" "$ROOTFS_SIZE" "$JNI_JSON" "$PARTS_JSON" <<'PY'
import json, sys
out, ver, abi, sha, size, jni, parts = sys.argv[1:8]
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
    "rootfsParts": json.loads("[" + parts + "]") if parts.strip() else [],
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
