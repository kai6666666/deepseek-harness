# DSH 桌宠工作台

浏览器端工具，把图片素材变成 DSH 悬浮球能播的**透明 WebM**，并生成 `preset.json`。

## 用法

双击 `DSH桌宠工作台.html`，用 **Chrome / Edge** 打开。全程本地处理，不上传任何文件。

## 为什么能生成透明视频

Chrome 的 `MediaRecorder` 录制 canvas 时保留 alpha 通道，输出 webm 带 `TAG:alpha_mode=1`。
Firefox / Safari 不支持，所以必须用 Chrome 系。

## 文件

| 文件 | 作用 |
|---|---|
| `DSH桌宠工作台.html` | **单文件版**（推荐分发），engine.js 已内联 |
| `index.html` | 开发版，引用外部 `engine.js` |
| `engine.js` | 素材处理引擎：导入 / 自动裁剪 / 导出 |

改代码时改 `index.html` + `engine.js`，然后合成单文件版：

```bash
python3 - << 'PY'
html = open('index.html', encoding='utf-8').read()
engine = open('engine.js', encoding='utf-8').read()
# MiniZip 块在 index.html 里，engine 直接内联
html = html.replace('<script src="engine.js"></script>',
                    '<script>\n' + engine + '\n</script>')
open('DSH桌宠工作台.html','w',encoding='utf-8').write(html)
PY
```

## 自动裁剪为什么用并集

每帧各自裁 → 尺寸不一致 → 切换动作时角色跳。
取所有帧的**并集**包围盒 → 所有帧同一尺寸 → 平滑切换。

## 实测记录

用 5 帧 200×200 的测试图验证：

- 包围盒识别 `x=[50,141] y=[60,139]`（含移动范围）
- 裁剪后 92×80，空白减少 82%
- 导出 184×160，`alpha_mode=1`，角落 alpha=0（真透明）
- 5 帧内容各不相同（动画正常）
- zip 打包通过 `unzip -t`

## 已知限制

- `ImageDecoder`（解 GIF 动画）在部分环境不可用，会退回只取第一帧并提示
- MediaRecorder 是实时录制，帧越多耗时越长（24 帧 ≈ 1 秒）
