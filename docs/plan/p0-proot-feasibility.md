# P0 可行性闸门：PRoot + glibc Node 在本机跑通（2026-11-09）

> 设备：Xiaomi 25104RADAC / Android 16 / arm64-v8a / kernel `6.1.138-android14-11-g0c3d559bcd85-ab14529422`
> 结论：**P0 三项判据全部通过**，单 PRoot 路线可继续。

---

## 一、构件（下载即校验）

| 文件 | 版本 | 大小 | SHA-256 |
|---|---|---|---|
| `proot_5.1.107.102_aarch64.deb` | 5.1.107.102 | 103,028 B | `10a394b585c2fc2b2c8502544f4e5f1be581dc8bfff79e8ba62f16207423e030` |
| `libtalloc_2.5.0_aarch64.deb` | 2.5.0 | 34,036 B | `556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7` |
| `libandroid-shmem_0.7_aarch64.deb` | 0.7 | 7,216 B | `0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6` |
| `ubuntu-base-24.04.5-base-arm64.tar.gz` | 24.04.5 | 29,936,675 B | （下载时由 Ubuntu SHA256SUMS 核对） |
| `node-v24.22.1-linux-arm64.tar.xz` | 24.22.1 | 30,978,868 B | （npmmirror SHASUMS256 核对） |

`readelf -d proot`：

```text
RUNPATH  /data/data/com.termux/files/usr/lib
NEEDED   libtalloc.so.2  libandroid-shmem.so  libc.so
```

→ `libtalloc.so.2` 不匹配 Android `lib*.so` 抽取规则；生产环境必须改名 + 改 `DT_NEEDED`（P0 用 `LD_LIBRARY_PATH` + 原名绕过）。

## 二、真机执行

```bash
# 目录（/data 是 ext4，可建符号链接；/sdcard 不行）
/data/local/tmp/p0a/
├─ proot                    （259,832 B，755）
├─ loader                   （18,136 B，755）
├─ libtalloc.so.2           （33,592 B）
├─ libandroid-shmem.so      （14,432 B）
└─ rootfs/                  （ubuntu-base 24.04.5 解包）

LD_LIBRARY_PATH=/data/local/tmp/p0a \
PROOT_LOADER=/data/local/tmp/p0a/loader \
./proot --kill-on-exit --link2symlink -0 \
  --rootfs=/data/local/tmp/p0a/rootfs \
  -b /dev -b /proc -b /sys --cwd=/root \
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp \
  /bin/echo proot-ok
```

## 三、结果

```text
$ ./proot … /bin/echo proot-ok
proot-ok
exit=0

$ ./proot … /bin/uname -a
Linux localhost 6.1.138-android14-11-g0c3d559bcd85-ab14529422 #1 SMP PREEMPT … aarch64 GNU/Linux

$ ./proot … /usr/bin/node -v
v24.22.1

$ 3 次 proot + node -e 0
731 ms（≈244 ms/次）

$ ps -A | grep -c p0a
0
```

## 四、踩坑记录

1. **`/storage/emulated/0` 是 FUSE，不能建符号链接**：`dpkg-deb -x` 解 talloc 时报
   `Cannot create symlink to 'libtalloc.so.2.5.0': Permission denied`。
   → rootfs 组装必须在 ext4（CI runner / Linux `/root` / `/data/local/tmp`）上做，工作区只存产物。
2. **`dpkg-deb -x` 目标目录要先 `mkdir -p`**，否则 `failed to create directory`。
3. **Ubuntu base 自带 `libstdc++.so.6` 与 `libgcc_s.so.1`**，node 直接可跑，不需要额外补库。
4. **/sdcard 上 `cp` 大文件慢**：node 123 MB 经工作区中转一次约数十秒，CI 里直接在 runner 上组装可避免。

## 五、对计划的三个修正

- proot 版本从 `5.1.107.98` 改 `5.1.107.102`（Termux 只留最新；旧 pin 需自存）；
- talloc/shmem 同步升到 `2.5.0` / `0.7`；
- `LD_LIBRARY_PATH` 不是可选项，是必需项（proot 的 RUNPATH 指向 Termux 路径）。
