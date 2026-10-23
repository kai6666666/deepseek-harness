#!/system/bin/sh
# import 插件并用假 ctx 跑 apply()：验证模块可加载、注册了哪几个工具
cd /data/user/0/ai.deepseek.harness/files || exit 1
unset LD_LIBRARY_PATH
R=usr/var/lib/proot-distro/installed-rootfs/ubuntu
mkdir -p tmp
export PROOT_TMP_DIR="$PWD/tmp"
export PROOT_LOADER="$PWD/bin/loader"
export TMPDIR="$PWD/tmp"
printf '#!/nonexistent\n' >/dev/null
timeout 60 ./bin/proot -0 -r "$R" --link2symlink \
  -b /proc -b "$PWD/tmp:/dev/shm" -b /proc/self/fd:/dev/fd \
  -b /dev/null -b /dev/urandom -b "$PWD" \
  -w /root /usr/bin/env -i \
  HOME=/root DSH_HOME=/root/.dsh TMPDIR=/tmp LANG=en_US.UTF-8 \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /bin/bash -lc 'cd /root && node /data/user/0/ai.deepseek.harness/files/modtest.mjs' 2>&1
echo "RC=$?"