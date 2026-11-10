#!/usr/bin/env bash
# 在本地用「仓库 tarball」复算 UI 契约门禁，避免本地只看工作区、
# 漏掉只在远端存在的文件（drawer-fix / polyfill 的教训）。
#
# 用法：
#   bash tools/ui-contract/verify-repo.sh [ref] [token文件]
# 默认 ref=main，token 读 <repo>/_build/.gh_token（可用环境变量 GH_TOKEN 覆盖）。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="${1:-main}"
TOKEN_FILE="${2:-$ROOT/../_build/.gh_token}"
REPO="${GH_REPO:-kai6666666/deepseek-harness}"
TOKEN="${GH_TOKEN:-$(cat "$TOKEN_FILE" 2>/dev/null)}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: 没有 GitHub token（_build/.gh_token 或 GH_TOKEN）" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TGZ="$TMP/repo.tgz"

echo "== 下载 $REPO@$REF =="
ok=0
for i in 1 2 3; do
  if curl -sL --max-time 180 \
      -H "Authorization: token $TOKEN" \
      "https://api.github.com/repos/$REPO/tarball/$REF" -o "$TGZ" \
     && tar tzf "$TGZ" >/dev/null 2>&1; then
    ok=1
    break
  fi
  echo "  下载失败，重试 $i/3" >&2
  sleep 3
done
[ "$ok" = 1 ] || { echo "ERROR: 三次下载都失败" >&2; exit 2; }

mkdir -p "$TMP/src"
tar xzf "$TGZ" -C "$TMP/src" --strip-components=1
cd "$TMP/src" || exit 2

echo "== 语法门禁 =="
for f in mobile-ui-plugin/dsh-android-mobile/lib/client.js \
         tools/ui-contract/audit.mjs \
         tools/ui-contract/extract.mjs; do
  node --check "$f" || { echo "FAIL syntax: $f" >&2; exit 1; }
done

echo "== UI 契约门禁 =="
node tools/ui-contract/audit.mjs --dead
MAX="$(node -e 'console.log(require("./tools/ui-contract/baseline.json").unique)')"
node tools/ui-contract/audit.mjs --max "$MAX"

echo "OK: 仓库 $REF 通过（基线 $MAX）"
