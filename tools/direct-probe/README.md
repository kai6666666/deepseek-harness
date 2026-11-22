# direct-probe（P4-a 探针）

用 glibc 的 `ld-linux-aarch64.so.1` 直接拉起 rootfs 里的 `node` + 引擎 `bin.js web`，**完全绕过 proot**。

## 用法
```sh
sh run.sh /data/user/0/com.dsh.android/files 46991
```
屏幕出现 `dsh web: http://127.0.0.1:46991/?token=…` 即成功；再用 `toybox nc 127.0.0.1 46991` 应得 `HTTP/1.1 401`（与 proot 同语义）。

## 真机结论（Xiaomi 25104RADAC / Android 16 / arm64-v8a）
| 项 | 结果 |
|---|---|
| loader → node | OK（Android16 的 seccomp 只在 x86_64 杀 loader） |
| `bin.js --version` | `0.2.2-rc.5`（exit 0） |
| `dsh web` 就绪 | **6.5 s**（proot 同口径 32.6 s，**省 ≈26 s**） |
| HTTP | `401`（健康语义一致） |

## 必需的环境垫片
`HOME`=rootfs/root、`TMPDIR`=rootfs/tmp（**缺它 spill-local 直接 EACCES**）、`PATH`=rootfs 的 bin、
`NODE_PATH`、`SSL_CERT_FILE`（**缺它 https 全失败**）、`TZ/LANG`、cwd=rootfs/root。

## 已知限制（P4-b 才解决）
- 引擎看到的路径是**宿主物理长路径**（`/data/user/0/.../rootfs/opt/dsh`），不是 `/opt/dsh`；
- 工具（bash）里的绝对路径指向宿主根；
- 需要 `paths.mjs` / `processes.mjs` 才能让 direct 与 proot 的路径语义一致。

详见 `docs/plan/perf-incremental.md` §7。
