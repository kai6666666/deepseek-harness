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
say "FAIL=$fail"
exit "$fail"