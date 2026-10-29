# VMOS+ 的 root 与 adb 探测（2026-10-29 实测）

> 目标：自行拿到 VMOS+ 的 `ip:port` 与 `su` 路径，为 `--root` 用例铺路。
> 结论先说：**这套 Android 15 内核镜像自带 `supportRoot: false`，因此没有可用的 root；guest 的 adb 也不在宿主 loopback 上。**

## ① 实测结论

| 项 | 实测值 | 判据 |
|---|---|---|
| VMOS 版本 | `com.vmos.plus`，进程 `:server` / `:vms01` / `vmos:init_1` | `pm list packages`、`ps -A` |
| guest 系统 | Android 15 / API 35 / romVersion `20008` | `guestOSInfo`（ROM 包内） |
| **root 支持** | **`"supportRoot": false`** | 同上 |
| 虚拟化类型 | `romType: KERNEL`、`libvmoskernel.so` | ROM 包内文件 |
| **guest adb** | **未暴露到宿主**：全量 LISTEN 端口里只有宿主自己的 adbd 应答 `CNXN` | 见 ② |
| 宿主 adb | `127.0.0.1:5666` → `device`，`uid=2000(shell)`，型号 `25104RADAC`，SDK 35 | `adb connect` 实测 |
| `su` 路径 | 该 ROM **不提供**（`supportRoot:false`，包内无 `su` 二进制） | ROM 包 560 条目全量列表 |

`guestOSInfo` 原文（节选）：

```json
{
  "guestSystemVersion": "ANDROID_15",
  "requiredEngineType": "KERNEL",
  "supportAbis": "arm64",
  "romVersion": "20008",
  "supportRoot": false,
  "supportFilesExchange": true,
  "isMultiInstance": true,
  "androidVersion": "15",
  "apiLevel": 35,
  "kernelRuntimeProfile": "a15-arm64-generation-v2"
}
```

## ② 探测方法（可复跑）

```bash
# 1) 宿主全量 LISTEN 端口（十六进制端口要转十进制）
cat /proc/net/tcp /proc/net/tcp6 | awk 'NR>1 && $4=="0A"{split($2,a,":");print a[2]}' \
  | sort -u | while read p; do printf '%d\n' 0x$p; done | sort -un
# 实测输出：3080 3081 3086 3090 3099 5037 5666 8093 13003 17163 33683 40693

# 2) 对每个端口做 adb 握手（CNXN）；只有 5666 回 CNXN，其余 silent/timeout
#    工具：tools/probe-vmos.mjs（内置 crc32 + CNXN 组包）

# 3) 连上宿主 adbd 确认身份
adb connect 127.0.0.1:5666 && adb -s 127.0.0.1:5666 shell 'id; getprop ro.product.model'
# → uid=2000(shell) / 25104RADAC

# 4) 读 VMOS ROM 元数据（guestOSInfo 在 7z 包里，包在 Android/data 下）
7z e -so /path/to/android15_user_20008.7z guestOSInfo
```

要点：`adb shell` 连的是**宿主自己的 adbd**（SDK 35、型号一致），不是 VMOS guest；VMOS 的 `8093/13003/17163` 连接后静默（不是 adb 协议）。

## ③ 下一步的三个选项

| 选项 | 做法 | 代价 |
|---|---|---|
| A. 换 ROM | VMOS+ 里下载 `supportRoot: true` 的镜像再启动 | 重新初始化 guest，需重新登录，最彻底 |
| B. 开 VMOS 的 ADB | 若该版本设置里有「ADB 调试 / 端口映射」，打开后重跑 ②，新端口会以 `ADBD_CNXN` 出现 | 取决于 VMOS 版本是否提供 |
| C. 保持冻结 | `--root` 继续 SKIP，root 项留在「环境不具备」 | 零成本，验收已按此口径 |

`app/src/main/assets/dsh-android-root.mjs` 的 su 候选表已按 Magisk 常见布局准备：`/system/bin/su`、`/system/xbin/su`、`/sbin/su`、`/debug_ramdisk/su`、`/su/bin/su`；换到 A 选项的 ROM 后直接 `--root` 就能命中。
