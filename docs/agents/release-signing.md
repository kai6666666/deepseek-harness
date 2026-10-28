# 发行签名（release signing）

> 现状：仓里只有 `assembleDebug` 出的包，发行签名这一段是空的。本页把它补成可执行流程。

## 为什么这一步不能含糊

签名就是应用身份，`app/build.gradle.kts` 里已经写死了这条约束：

- 换签名 → 老用户升级撞 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；
- 用户只能卸载重装，而卸载会清掉 `filesDir` 下的整个 Termux 环境与 `$DSH_HOME`；
- 所以这把 key 生成一次就终身使用，必须离线备份两份。

## ① 生成（本机，只跑一次）

```bash
sh tools/gen-release-keystore.sh              # 别名默认 dsh-release
sh tools/gen-release-keystore.sh my-alias "CN=..., O=..., C=CN"
```

产出（都被 `.gitignore` 排除，不会入库）：

| 文件 | 内容 |
|---|---|
| `keystore.jks` | RSA 4096 / 有效期 10950 天（30 年） |
| `keystore.properties` | `storeFile` / `storePassword` / `keyAlias` / `keyPassword`，权限 0600 |

`app/build.gradle.kts` 读的就是仓库根的 `keystore.properties`；文件不存在时自动退回 unsigned 包，别人 clone 后照样能构建。

**本次实跑结果（2026-10-29）**

```text
alias    : dsh-release
SHA1     : ED:45:D8:C6:D2:41:11:44:02:45:16:4B:61:E5:9F:F0:FB:B9:1D:D2
SHA256   : 79:D0:DA:B6:82:2C:27:6F:05:4B:B9:D5:3A:24:DD:65:FC:54:B3:A1:85:C9:02:A3:37:2B:10:90:A4:48:DC:96
jks sha256: af0f5b65a401338f016696cbcd9f8946ba2e3a8636019fa42b067ac0298fddbe
```

## ② CI 出包（`.github/workflows/android-release.yml`）

手动触发 `android-release`，先配 4 个仓库 secret：

| secret | 值 |
|---|---|
| `KEYSTORE_BASE64` | `base64 -w0 keystore.jks` 的输出 |
| `KEYSTORE_PASSWORD` | `keystore.properties` 里的 `storePassword` |
| `KEY_ALIAS` | `dsh-release` |
| `KEY_PASSWORD` | `keystore.properties` 里的 `keyPassword` |

流程：解码 keystore → 写 `keystore.properties` → `./gradlew :app:assembleRelease` → `apksigner verify --print-certs` → `sha256sum` → 上传 artifact `dsh-release-apk`。

## ③ 本地校验

```bash
BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
"$BT/apksigner" verify --print-certs app/build/outputs/apk/release/app-release.apk
```

证书 SHA-256 必须等于上面那串 `79:D0:…:DC:96`，不等就是签错了 key。

## ④ 回滚演练实测（2026-10-29）

| 演练 | 手法 | 结果 |
|---|---|---|
| A：引擎版本回退 | 把 `engine/node_modules/@deepseek-ai/dsh/package.json` 的 `version` 改成 `0.2.1-rc.3` → 跑套件 → 改回 `0.2.2-alpha.2` | `[FAIL] 引擎版本 0.2.1-rc.3` → 恢复后 `4 PASS / 0 FAIL`，**验收能拦住版本回退** ✅ |
| B：整包降级 | `pm install -r -d /data/local/tmp/dsh-v71.apk`（旧包 `DSH0.4.1-v71.apk`，147 MB） | `INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match` —— 旧包与装机包**签名不同**，降级只能卸载重装（清数据），因此整包回滚需现场确认，未在本轮执行 ⚠️ |
| C：装机 → 验收 → 回装 | `pm install -r -d /data/local/tmp/dshW2.apk` → 跑套件 → `pm install -r dsh-current-115.apk` → 跑套件 | 两步都 `Success`，装回后 `4 PASS / 0 FAIL`；「换包 → 验收 → 回基线」流程可执行 ✅ |

顺带确认的两件小事：

- `pm install` 读不到 `/sdcard`（`system_server` 无 `fuse` 读权限），安装包必须先 `cp` 到 `/data/local/tmp/`；
- 当前装机包已备份到 `/sdcard/Download/dshci/dsh-current-115.apk`（193 MB，`sha256` 前缀 `39eb8272…`），任何装机动作前先确认这份存在。
