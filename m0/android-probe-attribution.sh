#!/system/bin/sh
# 验证「坏 overlay 会让 dsh --dump-config 非零退出」——预检归因逻辑的前提
cd /data/user/0/ai.deepseek.harness/files || exit 1
unset LD_LIBRARY_PATH
R=usr/var/lib/proot-distro/installed-rootfs/ubuntu
mkdir -p tmp "$R/root/.dsh/overlays"
# 故意写坏：顶层不是补丁操作列表
printf 'this is not a patch list\n- foo: bar\n' > "$R/root/.dsh/overlays/bad.yml"
# 一个合法的用户 overlay
printf -- '- insert:\n    - id: user-demo\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: userdemo\n        transport: streamable-http\n        url: http://127.0.0.1:8765/mcp\n' > "$R/root/.dsh/overlays/good.yml"

export PROOT_TMP_DIR="$PWD/tmp"
export PROOT_LOADER="$PWD/bin/loader"
export TMPDIR="$PWD/tmp"

run() {
  ./bin/proot -0 -r "$R" --link2symlink \
    -b /proc -b "$PWD/tmp:/dev/shm" -b /proc/self/fd:/dev/fd \
    -b /dev/null -b /dev/urandom -b "$PWD" \
    -w /root /usr/bin/env -i \
    HOME=/root TMPDIR=/tmp PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /bin/bash -lc "cd /root && dsh web $1 --dump-config >/tmp/d.yml 2>&1; rc=\$?; echo \"[probe] rc=\$rc\"; [ \$rc -ne 0 ] && tail -c 300 /tmp/d.yml; exit \$rc"
}

echo "=== only builtin overlay ==="
run "--patch /root/mcp-android.overlay.yml"
echo "=== builtin + good ==="
run "--patch /root/mcp-android.overlay.yml --patch /root/.dsh/overlays/good.yml"
echo "=== builtin + bad ==="
run "--patch /root/mcp-android.overlay.yml --patch /root/.dsh/overlays/bad.yml"
echo "=== bad alone（归因用）==="
run "--patch /root/.dsh/overlays/bad.yml"
echo PROBE_TEST_DONE