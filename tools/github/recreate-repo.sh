#!/usr/bin/env bash
# recreate-repo.sh —— 删掉旧的 deepseek-harness 仓库，重建一个干净的（应用名仍是 DSH）
#
# 为什么是一条脚本而不是一串手打命令：
#   删除是**不可逆**操作。这里把「确认 → 删除 → 重建 → 初始化 → 首推」串起来，
#   并且默认不带 --yes 就停在"只报告、不动手"。
#
# 用法：
#   export GITHUB_TOKEN=ghp_xxx            # 需要 repo 权限（私有仓库还要 delete_repo 权限的 token）
#   bash tools/github/recreate-repo.sh --owner luojiaping --name deepseek-harness --dry-run
#   bash tools/github/recreate-repo.sh --owner luojiaping --name deepseek-harness
#   bash tools/github/recreate-repo.sh --owner luojiaping --name deepseek-harness --yes --push
#
# 参数：
#   --owner <o>        必填，GitHub 用户名/组织
#   --name <n>         默认 deepseek-harness
#   --source <dir>     本地要初始化的目录，默认 ./DSHAPP-main（相对仓库根）
#   --visibility       默认 private，可选 public
#   --app-name         默认 DSH（会校验 strings.xml 的 app_name）
#   --yes              真删（否则只报告）
#   --push             建仓后 git init + commit + push（默认不推）
#   --dry-run          全程只打印，不调任何写接口
#
# 退出码：0 成功；2 参数错；10 需要 --yes；11 API 失败；12 git 失败
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

OWNER=""
NAME="deepseek-harness"
SOURCE="$REPO_ROOT"          # 本脚本位于 <repo>/tools/github/，两个 .. 就是工程根（DSHAPP-main）
VIS="private"
APP_NAME="DSH"
DO_DELETE=0
DO_PUSH=0
DRY=0

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --visibility) VIS="$2"; shift 2 ;;
    --app-name) APP_NAME="$2"; shift 2 ;;
    --yes) DO_DELETE=1; shift ;;
    --push) DO_PUSH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$OWNER" ] || die "需要 --owner <github 用户名>" 2
case "$VIS" in private|public) ;; *) die "--visibility 只能是 private|public" 2 ;; esac

TOKEN="${GITHUB_TOKEN:-}"
API="https://api.github.com"
FULL="$OWNER/$NAME"

api() { # api <METHOD> <path> [json]  → stdout: body \n HTTPCODE
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" --max-time 30 \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      -d "$data" "$API$path" -w $'\n%{http_code}'
  else
    curl -sS -X "$method" --max-time 30 \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$API$path" -w $'\n%{http_code}'
  fi
}

say "=== 目标"
say "  仓库      : $FULL"
say "  可见性    : $VIS"
say "  本地源    : $SOURCE"
say "  应用名    : $APP_NAME"
say "  token     : $([ -n "$TOKEN" ] && echo '已设置' || echo '未设置（只能做匿名探测）')"
say "  dry-run   : $([ "$DRY" = 1 ] && echo yes || echo no)"
say ""

# ── 1) 探存在性（匿名也能查公开仓；私有仓需要 token） ────────────────
say "== 1/5 探测现有仓库"
if [ -n "$TOKEN" ]; then
  out="$(api GET "/repos/$FULL")"
else
  out="$(curl -sS --max-time 25 "https://api.github.com/repos/$FULL" -w $'\n%{http_code}')"
fi
BODY="${out%$'\n'*}"; CODE="${out##*$'\n'}"
EXISTS=0
case "$CODE" in
  200) EXISTS=1; say "   ⇒ 存在（HTTP 200）" ;;
  404) say "   ⇒ 不存在（HTTP 404；若是私有仓，未授权时也会 404）" ;;
  *)   say "   ⇒ HTTP $CODE: $(printf '%s' "$BODY" | head -c 200)" ;;
esac

if [ "$EXISTS" = "1" ] && [ "$DRY" = "0" ] && [ "$DO_DELETE" != "1" ]; then
  say ""
  say "仓库存在，但没给 --yes。**没有删任何东西。**"
  say "确认要删 $FULL 后重跑："
  say "  bash $0 --owner $OWNER --name $NAME --yes --push"
  exit 10
fi

# ── 2) 删除 ─────────────────────────────────────────────────────────
say ""
say "== 2/5 删除"
if [ "$EXISTS" != "1" ]; then
  say "   跳过（不存在或不可见）"
elif [ "$DRY" = "1" ]; then
  say "   [dry] DELETE $API/repos/$FULL"
else
  out="$(api DELETE "/repos/$FULL")"; CODE="${out##*$'\n'}"
  case "$CODE" in
    204) say "   ✓ 已删除 $FULL" ;;
    *)   say "   ✗ 删除失败 HTTP $CODE: $(printf '%s' "${out%$'\n'*}" | head -c 300)"
         say "   提示：私有仓删除需要 token 带 delete_repo scope："
         say "     https://github.com/settings/tokens → 勾选 repo + delete_repo"
         exit 11 ;;
  esac
fi

# ── 3) 重建 ─────────────────────────────────────────────────────────
say ""
say "== 3/5 新建"
if [ -z "$TOKEN" ] && [ "$DRY" = "0" ]; then
  die "新建仓库需要 GITHUB_TOKEN（export GITHUB_TOKEN=...）" 11
fi
if [ "$DRY" = "1" ]; then
  say "   [dry] POST /user/repos {\"name\":\"$NAME\",\"private\":$([ "$VIS" = private ] && echo true || echo false)}"
  CLONE="https://github.com/$FULL.git"
else
  payload="$(NAME="$NAME" VIS="$VIS" python3 -c '
import json, os
print(json.dumps({
    "name": os.environ["NAME"],
    "private": os.environ["VIS"] == "private",
    "description": "DSH — DeepSeek Harness Android 宿主（Alpine 单档运行时）",
    "has_issues": True, "has_wiki": False, "has_projects": False,
    "auto_init": False,
}, ensure_ascii=False))
')"
  out="$(api POST "/user/repos" "$payload")"
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
  case "$CODE" in
    201)
      CLONE="$(printf '%s' "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("clone_url",""))')"
      say "   ✓ 已创建：$CLONE"
      ;;
    *)
      say "   ✗ 创建失败 HTTP $CODE"
      say "   $(printf '%s' "$BODY" | head -c 300)"
      exit 11 ;;
  esac
fi

# ── 4) 应用名校验（应用名必须仍是 DSH） ─────────────────────────────
say ""
say "== 4/5 应用名校验"
STRINGS="$SOURCE/app/src/main/res/values/strings.xml"
if [ -f "$STRINGS" ]; then
  cur="$(grep -o '<string name="app_name">[^<]*</string>' "$STRINGS" | sed 's/.*>\(.*\)<.*/\1/')"
  say "   strings.xml app_name = ${cur:-?}"
  if [ "$cur" != "$APP_NAME" ]; then
    if [ "$DRY" = "1" ]; then
      say "   [dry] 会改写为 $APP_NAME"
    else
      python3 - "$STRINGS" "$APP_NAME" <<'PY'
import re, sys
p, want = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf-8").read()
s2 = re.sub(r'<string name="app_name">[^<]*</string>',
            f'<string name="app_name">{want}</string>', s)
open(p, "w", encoding="utf-8").write(s2)
print("   ✓ 已改写 app_name =", want)
PY
    fi
  else
    say "   ✓ 无需改动"
  fi
else
  say "   · 没找到 $STRINGS（源目录不对？）"
fi

# ── 5) 本地初始化 + 首推 ────────────────────────────────────────────
say ""
say "== 5/5 本地初始化"
[ -d "$SOURCE" ] || die "源目录不存在: $SOURCE" 12

GI="$SOURCE/.gitignore"
if [ ! -f "$GI" ]; then
  say "   写 .gitignore（含 tooling 缓存 + 40 MB rootfs 不入库）"
  [ "$DRY" = "1" ] || cat > "$GI" <<'EOF'
# 构建产物
build/
.gradle/
local.properties
*.apk
*.aab
*.iml
.idea/

# 依赖
node_modules/
**/node_modules/

# 运行时产物：40 MB rootfs 走 Release 附件，绝不进 git
app/src/main/assets/runtime/*.tar.gz
app/src/main/assets/runtime/*.sha256
dist/

# 补丁备份 / 临时
*.dshbak
.DS_Store
EOF
fi

if [ "$DO_PUSH" != "1" ]; then
  say "   · 未加 --push，跳过 git 操作"
else
  cd "$SOURCE" || die "进不去 $SOURCE" 12
  if [ ! -d .git ]; then
    if [ "$DRY" = "1" ]; then
      say "   [dry] git init -b main"
    else
      git init -q -b main || die "git init 失败" 12
    fi
  fi
  if [ "$DRY" = "1" ]; then
    say "   [dry] git add -A && git commit && git push $FULL main"
  else
    git add -A
    if git rev-parse HEAD >/dev/null 2>&1; then
      git commit -q -m "chore: 重建仓库基线（DSH / Alpine 单档）" || say "   · 无改动可提交"
    else
      git -c user.name="${GIT_AUTHOR_NAME:-DSH Builder}" \
          -c user.email="${GIT_AUTHOR_EMAIL:-builder@dsh.local}" \
          commit -q -m "chore: 初始化 deepseek harness（DSH / Alpine 单档）" || die "commit 失败" 12
    fi
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://github.com/$FULL.git"
    # token 只在这一次 push 的环境里，不写进 .git/config
    GIT_ASKPASS=/bin/echo \
    git -c credential.helper="!f() { test \"\$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"\$GITHUB_TOKEN\"; }; f" \
        push -u origin main 2>&1 | sed 's/x-access-token:[^@]*@/x-access-token:***@/g' \
      || die "push 失败（检查 token 是否带 repo 权限）" 12
    say "   ✓ 已推送 main"
  fi
fi

say ""
say "=== 完成"
say "  仓库：https://github.com/$FULL"
say "  下一步："
say "   1) Actions 里手动跑 alpine-rootfs（workflow_dispatch）"
say "   2) 下载 artifact → bash tools/fetch-rootfs-into-assets.sh --from <目录>"
say "   3) 40 MB rootfs 走 Release 附件或 artifact，不进 git（.gitignore 已挡）"