#!/usr/bin/env bash
# net-fetch.sh —— 下载的三级回退（对应 G-06 断点续传 / G-10 DNS 三级回退）
#
# 用法：
#   . tools/net-fetch.sh
#   net_fetch <url> <out> [expect_bytes] [expect_sha256]
#
# 三级策略（任一级成功即返回 0；全失败返回 4）：
#   ① 直连 + 断点续传（curl -C -）   ← 有半截文件就接着下，不重来
#   ② DNS 绕行（getent 拿 IP → curl --resolve）← 本机 DNS 被污染/超时也能连
#   ③ 镜像前缀替换（NF_MIRRORS 列表）  ← 域名整个不可达时的最后一条路
#
# 结束时一定校验：字节数（若给了）→ sha256（若给了）。校验不过 → 4。
#
# 环境变量：
#   NF_RETRY     每级重试次数，默认 4
#   NF_MIRRORS   空格分隔的前缀替换，例：'https://ghproxy.net/ https://gh-proxy.com/'
#   NF_QUIET     1 = 只打错误
set -uo pipefail

NF_RETRY="${NF_RETRY:-4}"
NF_MIRRORS="${NF_MIRRORS:-}"
NF_QUIET="${NF_QUIET:-0}"
# 私有 Release 资产需要 Authorization；设了 NF_AUTH 就统一带上 Bearer
NF_AUTH="${NF_AUTH:-}"
_nf_auth=()
[ -n "$NF_AUTH" ] && _nf_auth=(-H "Authorization: Bearer $NF_AUTH")

_nf_say() { [ "$NF_QUIET" = "1" ] || printf '    %s\n' "$*" >&2; }
_nf_err() { printf '  ✗ %s\n' "$*" >&2; }

_nf_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
  fi
}

_nf_size() { stat -c%s "$1" 2>/dev/null || echo 0; }

# 一级：直连（断点续传 + 重试）
_nf_direct() {
  curl -fL -C - --retry "$NF_RETRY" --retry-all-errors --retry-delay 2 \
    --connect-timeout 15 --max-time 1800 -o "$2" "${_nf_auth[@]}" "$1"
}

# 二级：解析 IP 后 --resolve 绕开本地 DNS
_nf_by_ip() {
  local url="$1" out="$2" host ip
  host="$(printf '%s' "$url" | sed -e 's#^[a-zA-Z0-9+.-]*://##' -e 's#[/?].*$##' -e 's#:.*$##')"
  [ -n "$host" ] || return 1
  ip="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')"
  [ -n "$ip" ] || ip="$(python3 -c 'import socket,sys;print(socket.gethostbyname(sys.argv[1]))' "$host" 2>/dev/null)"
  [ -n "$ip" ] || return 1
  _nf_say "DNS 回退：$host → $ip（--resolve）"
  curl -fL -C - --retry "$NF_RETRY" --retry-all-errors --retry-delay 2 \
    --connect-timeout 15 --max-time 1800 --resolve "$host:443:$ip" -o "$out" "${_nf_auth[@]}" "$url"
}

# 三级：镜像前缀替换
_nf_via_mirror() {
  local url="$1" out="$2" m
  [ -n "$NF_MIRRORS" ] || return 1
  for m in $NF_MIRRORS; do
    _nf_say "镜像回退：${m}${url}"
    curl -fL -C - --retry "$NF_RETRY" --retry-all-errors --retry-delay 2 \
      --connect-timeout 15 --max-time 1800 -o "$out" "${_nf_auth[@]}" "${m}${url}" && return 0
  done
  return 1
}

net_fetch() {
  local url="$1" out="$2" exp_size="${3:-}" exp_sha="${4:-}"
  local before=0
  [ -f "$out" ] && before="$(_nf_size "$out")"
  [ "$before" -gt 0 ] && _nf_say "断点续传：已有 ${before} B，从断点继续"

  if _nf_direct "$url" "$out"; then
    :
  elif _nf_by_ip "$url" "$out"; then
    :
  elif _nf_via_mirror "$url" "$out"; then
    :
  else
    _nf_err "三级下载全部失败：$url"
    return 4
  fi

  if [ -n "$exp_size" ]; then
    local got; got="$(_nf_size "$out")"
    if [ "$got" != "$exp_size" ]; then
      _nf_err "字节数不符：got=$got expect=$exp_size"
      return 4
    fi
  fi
  if [ -n "$exp_sha" ]; then
    local gotsha; gotsha="$(_nf_sha256 "$out")"
    if [ "$gotsha" != "$exp_sha" ]; then
      _nf_err "sha256 不符：got=${gotsha:0:12}… expect=${exp_sha:0:12}…"
      return 4
    fi
  fi
  _nf_say "下载完成：$(_nf_size "$out") B  $out"
  return 0
}

# 直接跑（不进 source）时：net-fetch.sh <url> <out> [size] [sha]
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ $# -ge 2 ] || { sed -n '2,26p' "$0"; exit 2; }
  net_fetch "$@"
fi