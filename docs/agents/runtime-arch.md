# ⑰ 运行时总体方案（Alpine 单档 + 工具链三层）

> 全文在 [../RUNTIME-ARCH-PLAN.md](../RUNTIME-ARCH-PLAN.md)。本文只留"动手时会踩的东西"。

## 结论（一句话）

引擎只跑 **Alpine（musl）** 一份；需要 apt 的走**可抛弃 Ubuntu overlay**；
产物进引擎前必须过 **ABI 守卫**（musl/static 放行，glibc/bionic 拒）。

## 三条铁律

1. **overlay 里永远不跑引擎** —— 否则就是变相双档，两套 engine ABI 互斥。
2. **产物进 Alpine 前过 ABI 守卫** —— `verify-toolchain.sh --abi <dir>`。
3. **overlay 是缓存不是资产** —— 可随时 `rm -rf`，引擎不许依赖它。

## 五个动词（唯一入口）

```bash
bash tools/dsh-runtime.sh status     # 档位 + 三层 + 体积
bash tools/dsh-runtime.sh doctor     # 缺什么给什么修复命令
bash tools/dsh-runtime.sh up alpine  # 切档
bash tools/dsh-runtime.sh run -- node -v
bash tools/dsh-runtime.sh verify     # 发布前必须全 0
bash tools/dsh-runtime.sh gc --all   # 清工具链层（Alpine 不受影响）
```

## 五个最容易翻车的点

| 点 | 现象 | 一句话 |
|---|---|---|
| `$?` 被 `tail` 吞掉 | 体检永远"通过" | 用临时文件接输出再取退出码（`dsh-runtime.sh verify` 已改） |
| proot 绑不存在的路径 | proot 直接退出，无报错线索 | 所有 `-b` 都要先判目录存在 |
| `.deb` 默认 zstd | 解包后"没有 usr/" | zstd → unzstd → python `zstandard` 三级兜底 |
| arm64 源用了 archive | 404 或只找到 x86 包 | 必须 `ubuntu-ports` + deb822 |
| `edit` 后可执行位丢失 | 脚本"找不到" | 判据用 `-f` 不用 `-x`（靠 `bash` 调起） |

## 还没补的（P0）

- **G-01** 档位枚举还是 `alpine|termux` 两个 → 单档收口未做
- **G-02** Alpine rootfs 真实产物未出（PRoot 内 `apk.static` SIGBUS）→ 要 CI
- **G-03** Kotlin 侧零接入（`EngineManager.kt` 10 123 行，接入点只有一处）
- **G-04** `assets/` 里没有 `alpine-rootfs.tar.gz`

完整 22 条见主文档 §5。
