#!/usr/bin/env bash
# verify-toolchain.sh —— 三层体检 + ABI 守卫（防止 glibc 产物污染 Alpine 引擎）
#
# 用法：
#   bash verify-toolchain.sh                 # 全量：overlay + deb + 路由表 + ABI 守卫
#   bash verify-toolchain.sh --overlay       # 只验 Ubuntu overlay（glibc / apt / 可选工具）
#   bash verify-toolchain.sh --deb           # 只验 deb 层（ELF 归属 + 缺库提示）
#   bash verify-toolchain.sh --abi <dir>     # ABI 守卫：扫目录，glibc/bionic 产物一律 FAIL
#   bash verify-toolchain.sh --which <cmd>   # 路由查询：这个命令该走 apk / deb / overlay
#   bash verify-toolchain.sh --json          # 机器可读输出
#
# 退出码：0 全通；1 有 FAIL；2 参数错
set -u

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TC_ROOT="${DSH_TC_ROOT:-$DSH_HOME/toolchain/ubuntu}"
DEB_ROOT="${DSH_DEB_ROOT:-$DSH_HOME/toolchain/deb}"
ROUTES="$HERE/toolchain.json"

fail=0
pass() { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; fail=$((fail+1)); }
skip() { printf '  · %s\n' "$*"; }

mode="all"
TARGET=""
case "${1:-}" in
  --overlay) mode="overlay" ;;
  --deb) mode="deb" ;;
  --abi) mode="abi"; TARGET="${2:-}" ;;
  --which) mode="which"; TARGET="${2:-}" ;;
  --json) mode="json" ;;
  "") mode="all" ;;
  -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
  *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
esac

# ── ELF 归属判定：用动态加载器字符串，不依赖 readelf ─────────────────
#   ld-linux-aarch64.so.1 → glibc；ld-musl-aarch64.so.1 → musl；都没有 → static
#   再补 GLIBC_ / musl libc / liblog.so 做二次确认
abi_of() {
  ABI_FILE="$1" python3 -c '
import os,sys
p=os.environ["ABI_FILE"]
try: d=open(p,"rb").read(4_000_000)
except Exception: print("unreadable"); raise SystemExit
if d[:4] != b"\x7fELF": print("not-elf"); raise SystemExit
glibc = (b"ld-linux-aarch64.so.1" in d) or (b"GLIBC_2." in d)
musl  = (b"ld-musl-aarch64.so.1" in d) or (b"musl libc" in d)
bionic= (b"liblog.so" in d) or (b"/system/lib64" in d) or (b"bionic" in d)
if bionic and not glibc and not musl: print("bionic")
elif glibc and not musl: print("glibc")
elif musl and not glibc: print("musl")
elif glibc and musl: print("mixed")
else: print("static")
'
}

case "$mode" in
  which)
    [ -n "$TARGET" ] || { printf '✗ --which 需要一个命令名\n' >&2; exit 2; }
    CMD="$TARGET" ROUTES="$ROUTES" python3 <<'PY'
import json, os
r = json.load(open(os.environ["ROUTES"]))
c = os.environ["CMD"]
hit = next((x for x in r["routes"] if x["cmd"] == c), None)
if not hit:
    print(f"{c}: 未在路由表 → 先看 Alpine 里有没有（which {c}），没有就用 overlay 试装")
    raise SystemExit(1)
lay = r["layers"][hit["layer"]]
print(f"{c}: layer={hit['layer']}  ({lay['desc']})")
if hit["layer"] == "deb":
    print(f"  取: bash deb-extract.sh --pkg {hit.get('pkg', c)}   （挂到 {lay.get('guestMount', '/opt/deb')}）")
elif hit.get("pkg"):
    print(f"  装: {lay.get('prep', 'apk add --no-cache')} {hit['pkg']}")
if hit.get("why"):
    print(f"  理由: {hit['why']}")
PY
    exit $?
    ;;

  abi)
    [ -n "$TARGET" ] || { printf '✗ --abi 需要一个目录\n' >&2; exit 2; }
    printf '== ABI 守卫: %s\n' "$TARGET"
    n=0
    while IFS= read -r f; do
      n=$((n+1))
      a="$(abi_of "$f")"
      case "$a" in
        musl|static|not-elf) pass "$a  ${f#$TARGET/}" ;;
        glibc|bionic|mixed)
          # .node / .so / 可执行二进制都是硬 FAIL；脚本外壳放行
          bad "$a  ${f#$TARGET/}  ← 不许进 Alpine 引擎" ;;
        *) bad "$a  ${f#$TARGET/}" ;;
      esac
    done < <(find "$TARGET" \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -path '*/bin/*' \) -type f 2>/dev/null | head -400)
    [ "$n" -gt 0 ] || skip "没找到 ELF 候选（*.node / *.so / bin/*）"
    printf '  扫描 %s 个文件，FAIL=%s\n' "$n" "$fail"
    [ "$fail" -eq 0 ] && exit 0 || exit 1
    ;;

  overlay)
    printf '== overlay 体检: %s\n' "$TC_ROOT"
    [ -x "$TC_ROOT/usr/bin/apt-get" ] && pass "apt-get 存在" || bad "apt-get 缺失（install-overlay.sh）"
    [ -f "$TC_ROOT/etc/apt/apt.conf.d/99-proot" ] && pass "proot apt 配置" || bad "缺 99-proot（apt 会因 setgroups 失败）"
    [ -f "$TC_ROOT/usr/sbin/policy-rc.d" ] && pass "policy-rc.d" || bad "缺 policy-rc.d（postinst 会卡）"
    [ -f "$TC_ROOT/etc/apt/sources.list.d/ubuntu.sources" ] && pass "deb822 源" || bad "缺源"
    if [ -x "$TC_ROOT/usr/bin/apt-get" ]; then
      out="$(bash "$HERE/tc-run.sh" --sandbox readonly -- ldd --version 2>&1 | head -2)"
      case "$out" in
        *GLIBC*|*glibc*|*GNU*libc*) pass "glibc: $(printf '%s' "$out" | head -1)" ;;
        *) bad "ldd 异常: $out" ;;
      esac
      out2="$(bash "$HERE/tc-run.sh" --sandbox readonly -- apt-get --version 2>&1 | head -1)"
      case "$out2" in
        *apt*) pass "apt: $out2" ;;
        *) bad "apt 跑不起来: $out2" ;;
      esac
    fi
    printf '  overlay 体积: %s MB\n' "$(du -sm "$TC_ROOT" 2>/dev/null | cut -f1)"
    ;;

  deb)
    printf '== deb 层体检: %s\n' "$DEB_ROOT"
    [ -d "$DEB_ROOT/pkgs" ] && pass "pkgs 存在" || skip "还没解过任何 deb"
    for d in "$DEB_ROOT"/pkgs/*; do
      [ -d "$d" ] || continue
      printf '  · %s (%s MB)\n' "$(basename "$d")" "$(du -sm "$d" | cut -f1)"
      while IFS= read -r f; do
        a="$(abi_of "$f")"
        case "$a" in
          glibc|mixed) printf '    ⚠ %s 是 %s → 需要 gcompat 才能跑（apk add gcompat libstdc++）\n' "$(basename "$f")" "$a" ;;
          *) printf '    ✓ %s (%s)\n' "$(basename "$f")" "$a" ;;
        esac
      done < <(find "$d/usr/bin" "$d/usr/sbin" "$d/bin" -type f -perm -u+x 2>/dev/null | head -20)
    done
    printf '  wrapper: %s\n' "$(ls -1 "$DEB_ROOT/bin" 2>/dev/null | tr '\n' ' ')"
    ;;

  json)
    printf '{ "overlay": {"root": "%s", "exists": %s}, "deb": {"root": "%s", "pkgs": %s}, "routes": "%s" }\n' \
      "$TC_ROOT" "$([ -x "$TC_ROOT/usr/bin/apt-get" ] && echo true || echo false)" \
      "$DEB_ROOT" "$(ls -1 "$DEB_ROOT/pkgs" 2>/dev/null | wc -l)" "$ROUTES"
    ;;

  all)
    bash "$0" --overlay; overlay_rc=$?
    echo
    bash "$0" --deb
    echo
    printf '== 路由表抽查\n'
    for c in java gradle gh aapt2 dotnet; do bash "$0" --which "$c" 2>/dev/null | sed 's/^/  /'; done
    echo
    printf '== ABI 守卫（Alpine 引擎目录）\n'
    ENG="$DSH_HOME/engine/node_modules"
    if [ -d "$ENG" ]; then bash "$0" --abi "$ENG" | tail -5; else skip "引擎目录不存在: $ENG"; fi
    [ "$overlay_rc" -eq 0 ] && [ "$fail" -eq 0 ] && exit 0 || exit 1
    ;;
esac

[ "$fail" -eq 0 ] && exit 0 || exit 1