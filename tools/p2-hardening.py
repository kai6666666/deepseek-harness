#!/usr/bin/env python3
"""p2-hardening.py —— 落实 P2 的 G-16 / G-18 / G-20 / G-21

G-17（proot -0 + 共享 $DSH_HOME）在 proot-launch.sh 里**已经按取舍实现**：
代码注释写明「proot 的 -b 没有 :ro，readonly 档的正确语义是不绑定 workspace」。
所以这里不动它，只把它的现状写进文档。

每处替换都断言「命中恰好 1 次」，任一处不符就不写盘。
"""
import sys
from pathlib import Path

T = Path(__file__).resolve().parent
ROOT = T.parent
subs = []


def sub(path: Path, old: str, new: str, why: str) -> None:
    subs.append((path, old, new, why))


# ── G-16：无 keyring 时不再静默 Trusted: yes ──────────────────────────
sub(
    T / "toolchain-overlay/install-overlay.sh",
    """  if [ -f "$KEYRING" ]; then
    printf 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\\n'
  else
    printf 'Trusted: yes\\n'
  fi""",
    """  if [ -f "$KEYRING" ]; then
    printf 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\\n'
  elif [ "${APT_INSECURE:-0}" = "1" ]; then
    # G-16：只有显式 APT_INSECURE=1 才允许关校验。
    #   以前的写法是「没 keyring 就写 Trusted: yes」——等于静默把签名校验关掉，
    #   日志里只有 keyring=no，没人会注意到装进来的包没验签。
    say "   ⚠ APT_INSECURE=1：无 keyring，本次关闭 apt 签名校验（仅调试用）"
    printf 'Trusted: yes\\n'
  else
    say "✗ 缺 keyring: $KEYRING" >&2
    say "  → 先 ensure-rootfs 装 ubuntu-keyring；或显式 APT_INSECURE=1 承担风险" >&2
    exit 33
  fi""",
    "G-16 Trusted 门禁",
)

# ── G-20：apt update 三级源回退 ───────────────────────────────────────
sub(
    T / "toolchain-overlay/install-overlay.sh",
    """  DSH_TC_ROOT="$TC_ROOT" DSH_PROOT="$DSH_PROOT" DSH_PROOT_LOADER="$DSH_PROOT_LOADER" \\
    bash "$HERE/tc-run.sh" --sandbox readonly -- apt-get update -qq \\
    || die "apt-get update 失败（网络/DNS/源）" 5
  say "   update ok\"""",
    """  # G-20：三级源回退。国内网络下单个镜像抽风很常见，硬失败会让用户以为「装不了」。
  SRC_FILE="$TC_ROOT/etc/apt/sources.list.d/ubuntu.sources"
  update_ok=0
  for fb in "$MIRROR" "https://mirrors.aliyun.com/ubuntu-ports" "http://ports.ubuntu.com/ubuntu-ports"; do
    [ -n "$fb" ] || continue
    if [ "$fb" != "$MIRROR" ]; then
      say "   ↻ 回退到 $fb"
      sed -i "s#^URIs: .*#URIs: $fb#" "$SRC_FILE"
    fi
    if DSH_TC_ROOT="$TC_ROOT" DSH_PROOT="$DSH_PROOT" DSH_PROOT_LOADER="$DSH_PROOT_LOADER" \\
      bash "$HERE/tc-run.sh" --sandbox readonly -- apt-get update -qq; then
      update_ok=1
      MIRROR="$fb"
      break
    fi
  done
  [ "$update_ok" = "1" ] || die "apt-get update 失败（3 个源都不可用：$MIRROR / aliyun / ports）" 5
  say "   update ok（源=$MIRROR）\"""",
    "G-20 三级源回退",
)

# ── G-18：deb 层缺库自动补 ────────────────────────────────────────────
sub(
    T / "toolchain-overlay/deb-extract.sh",
    """printf '\\n下一步：\\n'
printf '  1) Alpine 里补兼容层: bash ../alpine-runtime/proot-launch.sh -- apk add --no-cache gcompat libstdc++\\n'""",
    """# G-18：AUTO_DEPS=1 时直接把兼容层装上，而不是只打印一句「请自己装」
if [ "${AUTO_DEPS:-0}" = "1" ]; then
  printf '\\n补兼容层（AUTO_DEPS=1）…\\n'
  if bash "$(dirname "$0")/../alpine-runtime/proot-launch.sh" -- apk add --no-cache gcompat libstdc++ libgcc; then
    printf '   ✓ gcompat / libstdc++ / libgcc 已装\\n'
    DEPS_INSTALLED=1
  else
    printf '   ✗ 自动装失败，按下面第 1 步手动装\\n'
  fi
fi

printf '\\n下一步：\\n'
[ "${DEPS_INSTALLED:-0}" = "1" ] || printf '  1) Alpine 里补兼容层: bash ../alpine-runtime/proot-launch.sh -- apk add --no-cache gcompat libstdc++\\n'""",
    "G-18 AUTO_DEPS",
)

# ── G-21：verify-rootfs 输出可被诊断包吃掉的 JSON ─────────────────────
sub(
    T / "alpine-runtime/verify-rootfs.sh",
    """say ""
say "FAIL=$fail"
exit "$fail\"""",
    """say ""
# G-21：BUNDLE=1 时落一份 JSON，供 DiagnosticBundle / 崩溃现场直接引用，
#   而不是让人从终端往上翻 5 项结果。
if [ "${BUNDLE:-0}" = "1" ]; then
  _dir="${DSH_HOME:-$HOME/.dsh}/logs"
  _f="$_dir/verify-rootfs-$(date +%Y%m%d-%H%M%S).json"
  mkdir -p "$_dir" 2>/dev/null || true
  printf '{"tool":"verify-rootfs","fail":%s,"backend":"%s","ts":"%s"}\\n' \\
    "$fail" "${DSH_BACKEND:-alpine}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$_f" 2>/dev/null \\
    && say "bundle: $_f"
fi
say "FAIL=$fail"
exit "$fail\"""",
    "G-21 bundle",
)

fail = 0
changed = {}
for path, old, new, why in subs:
    src = changed.get(path) or path.read_text(encoding="utf-8")
    n = src.count(old)
    if n != 1:
        print(f"✗ {why}: 命中 {n} 次（应为 1）", file=sys.stderr)
        fail += 1
        continue
    changed[path] = src.replace(old, new, 1)
    print(f"✓ {why}")

if fail:
    print(f"\n{fail} 处失败，未写盘", file=sys.stderr)
    raise SystemExit(1)

for path, text in changed.items():
    path.write_text(text, encoding="utf-8")
    print(f"  → {path.relative_to(ROOT)}")