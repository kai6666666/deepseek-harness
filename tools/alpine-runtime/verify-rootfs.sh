#!/usr/bin/env bash
# verify-rootfs.sh —— 设备侧 Alpine 档启动验收（5 项，全绿才算通）
#
# 用法：
#   bash verify-rootfs.sh            # 用 backend-select resolve 的默认值
#   DSH_HOME=/data/data/.../files/.dsh bash verify-rootfs.sh
#
# 五项判据分别证明：proot 能起 / platform=linux / libc=musl / 官方 flock 零补丁 / dsh 引擎能应答
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
L="$HERE/proot-launch.sh"
fail=0

say() { printf '%s\n' "$*"; }
item() {
  if [ "$2" = "0" ]; then say "  ✅ $1"; else say "  ❌ $1"; fail=$((fail + 1)); fi
}

say "== 0) 档位与依赖"
if command -v node >/dev/null 2>&1; then
  node "$HERE/backend-select.mjs" doctor >/tmp/alt-doc.txt 2>&1
  item "doctor（详见 /tmp/alt-doc.txt）" "$?"
else
  say "  ! 没有 host node，跳过 doctor"
fi

say "== 1) proot 能起（--strict：禁止静默回退 termux，否则这一项会假绿）"
out=$(bash "$L" --strict -- /bin/sh -c 'echo PROOT_OK' 2>&1)
printf '%s' "$out" | grep -q PROOT_OK; item "guest sh 执行" "$?"

say "== 2) platform 必须是 linux"
out=$(bash "$L" --strict -- /usr/bin/node -p 'process.platform' 2>&1 | tail -1)
[ "$out" = "linux" ]; item "process.platform = $out" "$([ "$out" = "linux" ] && echo 0 || echo 1)"

say "== 3) libc 必须是 musl"
out=$(bash "$L" --strict -- /usr/bin/node -p 'process.report.getReport().header.glibcVersionRuntime?"glibc":"musl"' 2>&1 | tail -1)
[ "$out" = "musl" ]; item "libc = $out" "$([ "$out" = "musl" ] && echo 0 || echo 1)"

say "== 4) 官方 flock 零补丁可用"
out=$(bash "$L" --strict -- /usr/bin/node --input-type=module -e '
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import { openSync } from "node:fs";
await tryLockExclusive(openSync("/tmp/flock-probe","w"));
console.log("FLOCK_OK");
' 2>&1 | tail -1)
printf '%s' "$out" | grep -q FLOCK_OK; item "flock（$out）" "$?"

say "== 5) dsh 引擎能应答"
out=$(bash "$L" --strict -- /usr/bin/env node /dsh-home/engine/node_modules/@deepseek-ai/dsh/lib/bin.js \
        --profile web --dump-config 2>&1 | head -1)
printf '%s' "$out" | grep -Eq '^-|id:|name:'; item "dump-config 有输出（$out）" "$?"

say ""
# G-21：BUNDLE=1 时落一份 JSON，供 DiagnosticBundle / 崩溃现场直接引用，
#   而不是让人从终端往上翻 5 项结果。
if [ "${BUNDLE:-0}" = "1" ]; then
  # G-21：BUNDLE_DIR 可指向 filesDir/logs —— 那才是 DiagnosticBundle 会收的目录
  _dir="${BUNDLE_DIR:-${DSH_HOME:-$HOME/.dsh}/logs}"
  _f="$_dir/verify-rootfs-$(date +%Y%m%d-%H%M%S).json"
  mkdir -p "$_dir" 2>/dev/null || true
  printf '{"tool":"verify-rootfs","fail":%s,"backend":"%s","ts":"%s"}\n' \
    "$fail" "${DSH_BACKEND:-alpine}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$_f" 2>/dev/null \
    && say "bundle: $_f"
fi
say "FAIL=$fail"
exit "$fail"