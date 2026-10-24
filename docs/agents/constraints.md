# 两条硬约束

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## 两条硬约束（改动前必读，改错不报错但真机必炸）

### ① 包名必须恰好 15 字符

`applicationId` / `namespace` = `com.dsh.android`（15 字符）。

Termux 官方二进制把 `/data/data/com.termux/files`（27 字节）烤进 ELF 的 `.dynstr`，
`TermuxBootstrap.patchElfInPlace()` 只能做**等长原地覆盖**，替换串
`/data/data/<包名>/` = 12 + N 字节，等于 27 ⇒ **N = 15**。

长度不等时该函数直接 `return 0` **静默跳过**，不抛异常；症状是运行时
`CANNOT LINK EXECUTABLE` 或 `dpkg: Permission denied`。改包名必须同步改
`TermuxBootstrap.ELF_ROOT_REPLACEMENT`，两处字符数必须一致。

> `app/build.gradle.kts` 注释里提到的 `termux-kit/tools/verify-kit.ps1` **不在本仓库**，
> 不必去找。校验方式就是数字符。

### ② targetSdk 必须 ≤ 28

**不能升到 29+。** Android 10（API 29）起，targetSdk ≥ 29 的应用不允许 `execve()`
自身私有目录里的文件（W^X / SELinux `untrusted_app` 域禁止 `app_data_file`
`execute_no_trans`），而 node / bash / dpkg 全都装在 `filesDir` 下的 `$PREFIX` 里，
一升级就全线 Permission denied。Termux 官方 App 同样停在 28。

**代价**：只能侧载，无法上架 Google Play。

