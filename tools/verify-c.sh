#!/usr/bin/env bash
# C 方案验收矩阵 —— proot(glibc) 宿主 + 用户态沙箱
#
# 用法（在 proot Ubuntu 内、引擎已停时跑）：
#   ROOT=/ DSH_HOME=/data/data/com.dsh.android/files/home/.dsh \
#   WORKSPACE=$DSH_HOME/workspace ./tools/verify-c.sh
#
# 判据分四组：
#   ① 平台翻面   —— 证明跑的是 linux 分支
#   ② 官方预编译 —— C 方案的全部收益（flock/sharp/node-pty/node:sqlite）
#   ③ 沙箱边界   —— 写放行/写拒绝/*at 覆盖/readonly/未知 flag fail-closed
#   ④ 端到端     —— headless 跑一条真实任务（需要已配置模型）
#
# 不要用 `set -e`：每条检查都要独立结算，不能一条失败就退出。

set -u

DSH_HOME="${DSH_HOME:-/data/data/com.dsh.android/files/home/.dsh}"
WORKSPACE="${WORKSPACE:-$DSH_HOME/workspace}"
RUNNER="${RUNNER:-/usr/local/bin/boo-sandbox-run}"
BOOLIB="${BOOLIB:-/usr/local/lib/libboosandbox.so}"
LINKLIB="${LINKLIB:-/usr/local/lib/liblinkcompat.so}"

PASS=0
FAIL=0
ok()  { printf '✅ %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '❌ %s\n   %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# bwrap 方言：read-only 形态
conf_ro() {
  BOO_SANDBOX_LIB="$BOOLIB" TMPDIR="${TMPDIR:-/tmp}" \
    "$RUNNER" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- "$@"
}
# bwrap 方言：workspace-write 形态（多一个 --tmpfs 与 --bind）
conf_ws() {
  BOO_SANDBOX_LIB="$BOOLIB" TMPDIR="${TMPDIR:-/tmp}" \
    "$RUNNER" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent \
    --tmpfs /tmp --bind "$WORKSPACE" "$WORKSPACE" -- "$@"
}

echo "== 参数 =="
echo "DSH_HOME=$DSH_HOME"
echo "WORKSPACE=$WORKSPACE"
echo "RUNNER=$RUNNER"
echo

# ── ① 平台翻面 ────────────────────────────────────────────────────────────
echo "== ① 平台与运行时 =="
p="$(node -e 'console.log(process.platform)' 2>/dev/null || echo none)"
if [ "$p" = "linux" ]; then
  ok "process.platform=linux（官方 linux 分支生效）"
else
  bad "process.platform=$p" "必须跑 glibc 版 node；bionic 版会报 android"
fi

# ── ② 官方预编译 ──────────────────────────────────────────────────────────
echo
echo "== ② 官方 linux-arm64 预编译 =="
if node -e "require('@deepseek-ai/node-addon-system/flock')" >/dev/null 2>&1; then
  ok "flock（会话写锁）加载成功"
else
  bad "flock 加载失败" "缺 glibc 版 system.node；会话写锁拿不到 = 每轮回复失败"
fi

if vips="$(node -e "const s=require('sharp');console.log(s.versions.vips)" 2>/dev/null)"; then
  ok "sharp 加载成功（libvips $vips）"
else
  bad "sharp 加载失败" "缺 @img/sharp-linux-arm64；附件图片管线不可用"
fi

if node -e "require('node-pty')" >/dev/null 2>&1; then
  ok "node-pty 加载成功（侧栏终端可用）"
else
  bad "node-pty 加载失败" "PTY 不可用；bash 工具本身不依赖它，但终端面板会空"
fi

if node -e "require('node:sqlite')" >/dev/null 2>&1; then
  ok "node:sqlite 可用（session_search 可开）"
else
  bad "node:sqlite 不可用" "Node 需 22+；全文检索只能保持 openAt: never"
fi

# ── ③ 沙箱边界 ────────────────────────────────────────────────────────────
echo
echo "== ③ 沙箱边界 =="
mkdir -p "$WORKSPACE" 2>/dev/null

if conf_ws /bin/bash -c "echo ok > '$WORKSPACE/.verify_write' && cat '$WORKSPACE/.verify_write'" >/dev/null 2>&1; then
  ok "workspace 内写入放行"
else
  bad "workspace 内写入被拒" "检查 BOO_SANDBOX_ALLOW 与 /data/user/0 ↔ /data/data 两种拼写"
fi

outside="$(dirname "$WORKSPACE")/ESCAPED_BY_VERIFY"
if conf_ws /bin/bash -c "echo no > '$outside'" >/dev/null 2>&1; then
  bad "workspace 外写入未被拦截" "严重：BOO_SANDBOX_MODE/ALLOW 未生效"
  rm -f "$outside" 2>/dev/null
else
  ok "workspace 外写入被拒"
fi

if conf_ws /bin/bash -c "mkdir '$outside.dir'" >/dev/null 2>&1; then
  bad "mkdirat 逃逸未被拦截" "glibc 下必须覆盖 mkdirat（历史逃逸点）"
  rmdir "$outside.dir" 2>/dev/null
else
  ok "mkdirat（install -d 同路径）被拒"
fi

if conf_ro /bin/bash -c 'echo x > /tmp/.verify_ro' >/dev/null 2>&1; then
  bad "readonly 模式仍可写 /tmp" "模式解析失败"
  rm -f /tmp/.verify_ro
else
  ok "readonly 模式拒绝一切写"
fi

if conf_ws /bin/bash -c 'echo x > /dev/null' >/dev/null 2>&1; then
  ok "/dev/null 始终可写（普通重定向不被误杀）"
else
  bad "/dev/null 被误杀" "g_dev_allow 表缺失或被改坏"
fi

set +e
BOO_SANDBOX_LIB="$BOOLIB" "$RUNNER" --totally-unknown-flag -- /bin/true >/dev/null 2>&1
rc=$?
set -e 2>/dev/null
if [ "$rc" = "125" ]; then
  ok "未知 flag → exit 125（fail-closed）"
else
  bad "未知 flag 返回 $rc" "必须 125；否则不理解的 profile 会被放行"
fi

# link 转译（proot 下 link 可能 ENOSYS）
if LD_PRELOAD="$LINKLIB" node -e "
  const fs=require('fs'),p='/tmp/.verify_link_src',q='/tmp/.verify_link_dst';
  fs.writeFileSync(p,'x'); try{fs.unlinkSync(q)}catch{}
  fs.linkSync(p,q); if(fs.readFileSync(q,'utf8')!=='x') process.exit(3);
" >/dev/null 2>&1; then
  ok "link() 转译成功（会话日志原子发布可用）"
else
  bad "link() 转译失败" "proot 返回 ENOSYS；确认已打 apply-glibc-patches.py 的 ENOSYS 补丁"
fi

# ── ④ 端到端（可选） ──────────────────────────────────────────────────────
echo
if [ "${RUN_HEADLESS:-0}" = "1" ]; then
  echo "== ④ headless 端到端 =="
  out="$(dsh headless --json "回答两个字：收到" 2>&1 | tail -n 20)"
  if printf '%s' "$out" | grep -q '"type"'; then
    ok "headless 产出 NDJSON 事件流"
  else
    bad "headless 未产出事件流" "$out"
  fi
  if printf '%s' "$out" | grep -qiE 'did not activate|SANDBOX_UNAVAILABLE|SessionAlreadyOwned'; then
    bad "headless 日志含致命错误" "$out"
  else
    ok "无 did not activate / SANDBOX_UNAVAILABLE / SessionAlreadyOwned"
  fi
else
  echo "（跳过 ④；要跑端到端：RUN_HEADLESS=1 $0）"
fi

echo
echo "== 汇总：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ] || exit 1