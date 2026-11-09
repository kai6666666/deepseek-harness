# 调试与验证探针集合 (tools/probe/)

本目录归档在真机 UI 诊断与端到端验收中使用的全量探针脚本。

## 探针清单

| 脚本 | 描述 |
|---|---|
| `probe-lralign.js` | 验证会话页左上按钮与右上按钮在几何（rect/top/dyTop/dyH/dyW）、SVG 尺寸、内边距、display/position 属性上的严格一致性 |
| `probe170.js` - `probe177.js` | 抽屉在进入设置页时的行为探测系列（含遮罩层级、DOM 状态、MutationObserver 取证） |
| `probe180.js` - `probe185.js` | 头部栏高度对齐、DOM 结构与图标样式的细粒度探测 |
| `probe186.js` | 按钮边距、位置与主界面 UI 边界核验 |
| `probe187.js` | 左按钮移入 header 布局与双图标消除的阶段性验收探针 |
| `probe188.js` | 深度探测非会话页面（插件/设置/智能体）的 header leading 元素状态及汉堡按钮回退逻辑 |
| `probe190.js` | 多模态齿轮图标展示与 SVG 选择器适配探测 |

## 使用方式
将目标探针脚本追加或注入到调试页面的 client bundle 或执行环境：
```sh
cat tools/probe/probe-lralign.js >> client.js
```