#!/system/bin/sh
# 带插件起 dsh（port 0），抓到 URL 后 curl 验 303 —— 复现 in-app probe 那一步
cd /data/user/0/ai.deepseek.harness/files || exit 1
unset LD_LIBRARY_PATH
R=usr/var/lib/proot-distro/installed-rootfs/ubuntu
mkdir -p tmp
export PROOT_TMP_DIR="$PWD/tmp"
export PROOT_LOADER="$PWD/bin/loader"
export TMPDIR="$PWD/tmp"
rm -f probe303.log
setsid ./bin/proot -0 -r "$R" --link2symlink \
  -b /proc -b "$PWD/tmp:/dev/shm" -b /proc/self/fd:/dev/fd \
  -b /dev/null -b /dev/urandom -b "$PWD" \
  -w /root /usr/bin/env -i \
  HOME=/root DSH_HOME=/root/.dsh TMPDIR=/tmp LANG=en_US.UTF-8 \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /bin/bash -lc 'cd /root && exec dsh web --patch /root/android-bridge.overlay.yml --no-open --port 0' \
  > probe303.log 2>&1 < /dev/null &
i=0
U=""
while [ $i -lt 40 ]; do
  sleep 2
  i=$((i + 1))
  U=$(grep -o 'dsh web: http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' probe303.log | tail -1 | sed 's/^dsh web: //')
  [ -n "$U" ] && break
done
echo "waited=$((i * 2))s url=$U"
if [ -n "$U" ]; then
  echo "token_code=$(curl -s -o /dev/null -w '%{http_code}' "$U")"
  P=$(echo "$U" | sed -E 's#.*:([0-9]+)/.*#\1#')
  echo "bare_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$P/")"
fi
echo "--- engine log ---"
tail -12 probe303.log
pkill -f 'dsh web --patch /root/android-bridge.overlay.yml' 2>/dev/null
echo PROBE303_DONE