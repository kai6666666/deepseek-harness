# 深海女仆工坊 0.3.2 · 本机适配记录

## 环境

| 项目 | 值 |
|---|---|
| DSH | `0.2.2-alpha.2` |
| Android UI build | `1.1.0-160` |
| dsh-web-all | `0.4.14` |
| skin-center | `0.4.14` |
| dshmarket | `1.73.7` |
| 视口 | 394 × 806 CSS px，DPR 3.25 |
| 主题 | 深色 / 浅色均测 |

## 结论

**适配。** 深海女仆工坊 `maid-atelier@0.3.2` 可以在本机安装、激活并正常渲染；
没有横向溢出，也没有破坏 mobile-ui-plugin 的抽屉、菜单和创建插件入口。

## 安装与契约

市场条目：

```text
id       maid-atelier
name     深海女仆工坊 / Abyssal Maid Atelier
version  0.3.2
author   Small-tailqwq
source   https://github.com/Small-tailqwq/dsh-deep-whale/tree/main/maid-atelier
```

安装位置：

```text
/data/user/0/com.dsh.android/files/home/.dsh/skins/maid-atelier
```

文件数 26，体积 2.7 MB。`skin.json` 声明：

```json
{
  "skinManifestVersion": 2,
  "version": "0.3.2",
  "requires": {
    "contracts": [
      {
        "apiVersion": "x-org.linxin666.skin-center/v1alpha1",
        "kind": "SkinHooks",
        "optional": true
      }
    ]
  }
}
```

本机 `@linxin666/dsh-client-ui-skin-center@0.4.14` 要求 DSH `>=0.2.1-rc.3`，本机
`0.2.2-alpha.2` 满足；`hooks.mjs` 正常加载，SkinHooks 为可选契约，不阻塞应用。

## 渲染结果

激活后：

```text
html[data-dsh-skin="maid-atelier"]
body[data-ds-dark-theme]        # 深色态
document.scrollWidth = innerWidth = 394
```

加载到的关键资源：

```text
maid-atelier-palace-night-v4.webp  1586 × 992
maid-atelier-maid-left-v5.webp     1122 × 2019
maid-atelier-maid-right-v6.webp    1394 × 2649
maid-chibi-v1.webp                  620 × 553
```

`skin.css` 变量与 `patches.css` 均已注入；`--maid-*`、`--dsw-alias-*` token 生效。

## 移动端布局

| 项目 | 深色 | 浅色 |
|---|---:|---:|
| innerWidth | 394 | 394 |
| document.scrollWidth | 394 | 394 |
| 主内容列 | 394 | 394 |
| 抽屉侧栏 | 320 | 320 |
| composer | 392 | 392 |
| 输入框 | 324 | 324 |
| 市场卡片 | 362 | 362 |

侧栏打开时 `.mp-drawer-mask` 正常，`data-mp-drawer-open` 正常；
web-all 的 `::after` 第二层遮罩仍被 mobile-ui-plugin 关闭。

## 功能回归

在皮肤激活状态下：

```text
会话「⋯」菜单          7 项
创建你的插件            创造模式
官方提示词              创建一个 DSH 会话视图插件。
msgs                    0
dshmarket 发现页        root/head/body 394，卡片 362
dshmarket 五标签页      394 全宽，无横向溢出
安装确认弹窗            346 × 454，可取消
```

## 证据

```text
/sdcard/Download/maid-atelier-settings-160.png
/sdcard/Download/maid-atelier-sidebar-160.png
/sdcard/Download/maid-atelier-session-160.png
/sdcard/Download/maid-atelier-market-160.png
/sdcard/Download/maid-atelier-light-market-160.png
```

## 注意事项

- 这里的 `0.3.2` 是 skin-center 的**皮肤资产包**版本，不是市场里
  `@smalltailqwq/dsh-client-ui-skin-maid-atelier` 插件条目的 `0.1.9` 版本。
- 皮肤按 `<=1080px / <=700px / <=480px` 做了移动断点；本机 394px 落在最小断点内。
- 皮肤资产约 2.7 MB，首次加载会有一次图片解码成本；之后由 skin-center 缓存。
