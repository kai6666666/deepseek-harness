#!/system/bin/sh
# 把「下拉双击去重」热补丁装到引擎运行时目录（不需重装 APK）
#
# 用法（设备侧 shell，uid 2000；不要包 run-as；脚本自己会 run-as）：
#   sh apply-clickfix.sh            # 安装 / 更新
#   sh apply-clickfix.sh --check    # 只检查状态
#
# 原理：EngineManager.ensureWebCompat() 每次启动都会
#   ① 用 assets/webview-polyfill.js 覆盖 dist/webview-polyfill.js
#   ② 若 index.html 里没有 polyfill 标签就插一个
# 所以不能改 polyfill 本身（会被覆盖）。这里改成插**额外的** dsh-clickfix.js +
# index.html 里多一个 script 标签；引擎升级重解包 dist 后才会消失，
# 届时 APK 侧 assets 已带同一段逻辑（见 tools/dsh-clickfix.js 头注释）。
PKG=com.dsh.android
D=files/engine/node_modules/@deepseek-ai/dsh-web-frontend/dist
SRC=${1:-/data/local/tmp/dsh-clickfix.js}

state() {
    run-as $PKG sh -c "D=$D
        [ -f \$D/dsh-clickfix.js ] && echo 'file: yes' || echo 'file: no'
        grep -q dsh-clickfix.js \$D/index.html 2>/dev/null && echo 'tag:  yes' || echo 'tag:  no'" 2>/dev/null
}

if [ "$1" = "--check" ]; then
    state
    exit 0
fi

[ -f "$SRC" ] || { echo "缺少补丁源：$SRC"; exit 1; }
cat "$SRC" | run-as $PKG sh -c "D=$D
    cat > \$D/dsh-clickfix.js
    grep -q dsh-clickfix.js \$D/index.html || sed -i 's#<script src=\"./webview-polyfill.js\">#<script src=\"./dsh-clickfix.js\"></script><script src=\"./webview-polyfill.js\">#' \$D/index.html" || exit 1

state
echo "---- 重启 App 后生效：am force-stop $PKG && am start -n $PKG/.MainActivity"