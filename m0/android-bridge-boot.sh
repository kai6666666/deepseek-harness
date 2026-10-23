#!/system/bin/sh
# 同上，但把输出落到文件再 cat（避免管道被 timeout 截断）
cd /data/user/0/ai.deepseek.harness/files || exit 1
unset LD_LIBRARY_PATH
R=usr/var/lib/proot-distro/installed-rootfs/ubuntu
mkdir -p tmp
export PROOT_TMP_DIR="$PWD/tmp"
export PROOT_LOADER="$PWD/bin/loader"
export TMPDIR="$PWD/tmp"
rm -f bridge.log
timeout 60 ./bin/proot -0 -r "$R" --link2symlink \
  -b /proc -b "$PWD/tmp:/dev/shm" -b /proc/self/fd:/dev/fd \
  -b /dev/null -b /dev/urandom -b "$PWD" \
  -w /root /usr/bin/env -i \
  HOME=/root DSH_HOME=/root/.dsh TMPDIR=/tmp TERM=xterm-256color LANG=en_US.UTF-8 \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /bin/bash -lc 'cd /root && exec dsh web --patch /root/android-bridge.overlay.yml --no-open --port 0' > bridge.log 2>&1
echo "RC=$?"
echo "=== bytes=$(wc -c < bridge.log) ==="
tail -40 bridge.log