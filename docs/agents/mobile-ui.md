# 移动端 UI 插件（`mobile-ui-plugin/dsh-android-mobile`）

改移动端布局 / 样式前先读这一页。三个高频坑都在这里踩过，且都有真机取证的结论。

---

## 1. 设计 token：只能用真实存在的名字

DSH 的设计变量只有下面这些（`dsh-web-frontend/dist/assets/index-*.css` 里 grep 出来的）：

| 类别 | 真实 token |
|---|---|
| 背景 | `--dsw-alias-bg-base` / `bg-layer-1` … `bg-layer-4` / `bg-mask-1` / `bg-module-platform` / `bg-skeleton` |
| 文字 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-caption` / `-dimmed` / `-error` / `-shimmer` / `-primary-foreground` |
| 边框 | `--dsw-alias-border-l1` … `border-l4` / `border-l2-darkmode-thin` |

**不存在**：`bg-elevated`、`bg-subtle`（这两个是我自己编的，写进 `var()` 会让整条声明作废）。

纪律：

- `var()` 的 fallback **必须与主题一致**；宁可 `transparent`，绝不写死浅色。
- 关键浮层（弹窗）再叠一层显式兜底：每次读 `body[data-ds-dark-theme]`，**不要缓存进组件 state**
  （切主题不会重建这个分节）。

历史事故：深色模式下「检查完成 / 正在检查」弹窗白底浅字 —— 原因就是 `bg-elevated` 不存在。
修法与像素验收见 `1.1.0-219/220`。

---

## 2. 插件详情页「插件声明的详细介绍文件无效」

**两个独立根因，缺一不可**：

### 2.1 `tools/runtime/build-runtime.sh` 删了 `docs/`

```bash
# 改前（两处都会踩，且**必须同时修**）
find … -name '*.md' -delete                          # ① 连 docs/DETAIL.md 一起删
find … -type d \( -name docs -o -name … \) -delete    # ② 把整个 docs/ 目录删掉
```

⚠️ **只修 ② 是不够的** —— 2026-11-24 实测 `debug.32` 的 rootfs：

```text
16 个包有 docs/ 目录，但里面只剩 preview.svg
detail_md=0     ← DETAIL.md / DETAIL.zh.md 全没了
```

原因就是 ① 那条 `-name '*.md' -delete` 只豁免了 `README.md` / `readme.md`，
没有豁免 `docs/` 下的 md。**两条规则都要改**：

```bash
find "$ROOTFS/opt/dsh/node_modules" -type f \( -name '*.map' -o -name '*.md' -o -name '*.markdown' \) \
  ! -name 'README.md' ! -name 'readme.md' ! -path '*/docs/*' -delete

find "$ROOTFS/opt/dsh/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \
  -o -name example -o -name examples \) -delete      # 注意：docs 已从这里移除
```

修 ① 之后还需要**重新构建 runtime 才会生效**；在那之前，设备上只能手工把
`docs/*.md` 拷回去（`tools/plugin-docs.py` 产出 → `run-as` 里 `cp -f`）。

插件 `package.json` 的 `files` 里写着 `"docs"`，`@deepseek-ai/dsh-plugin-detail` 就是按这个约定
去读 detailed 介绍：

```text
<pkg>/docs/
  DETAIL.md          ← 英文详细介绍
  DETAIL.zh.md       ← 中文详细介绍
  preview.svg / preview.zh.svg   ← 预览图
```

⇒ 已改成**保留 `docs/`**（删掉 test/example 那两条仍然保留）。

### 2.2 `README.i18n.yaml` 是哈希旁签，不是正文

```yaml
# Bilingual-pair consistency record for README.md: per heading section,
# a hash of its English and Chinese blocks …
/:
  en: d7cf0e812c2b84ef
  zh: 959798411569393e
```

它记录官方 README 每个标题段的中英哈希。**人手塞进去的 README 对不上这些哈希** ⇒ 同样判「无效」。
运行时用不到它，改名成 `.bak` 即可绕开（构建期工具才需要）。

### 2.3 补文件的工具

```bash
# 真实 docs（jsDelivr 目录 API + 逐文件下载）
python3 tools/plugin-docs.py pkgs.txt docsout 0.2.2-rc.5 --fallback --keep-map

# 产物：docsout/@deepseek-ai__<name>/docs/…
# 清单：docsout/docs.map（包名|@deepseek-ai/短名）
# --fallback ：没有 docs 的包用 npm description 生成最小 DETAIL.md
# --keep-map ：与已有 map 合并（不合并会「第二次只跑两个包就把清单覆盖成两行」）
```

装进设备（`run-as` 里 `R` 要用**绝对路径**，`cd` 到别处后相对路径会失效）：

```bash
run-as com.dsh.android sh -c '
  R=/data/user/0/com.dsh.android/files/runtime/rootfs/opt/dsh/node_modules/@deepseek-ai
  cd /data/local/tmp/docs3
  for s in @deepseek-ai__*; do
    [ -d "$s/docs" ] || continue
    d="$R/${s#@deepseek-ai__}"; [ -d "$d" ] || continue
    mkdir -p "$d/docs"; cp -r "$s/docs/." "$d/docs/"
  done'
```

⚠️ **重建 runtime 会覆盖手工补的文件** —— 根治靠的是构建脚本那一条规则（2.1），不是手工 cp。

---

## 3. 插件页对齐（标题左对齐 / 列表贴边）

### 3.1 为什么不能用 CSS 选择器

插件页容器的 class 是 **CSS Modules 哈希**（`_root_x1y2z_3` 这种），官方每次发版重算，
写死必碎。正确做法：**认语义标签 + 几何特征**，运行时打 inline style。

### 3.2 怎么取证（探针，而不是猜）

在 client.js 里打一行 `console.log('[MP-ALIGNn] ' + JSON.stringify({vw, nodes}))`，
**落到 `files/logs/web.log`**（WebView 的 console 走这里，不是 app.log）：

```bash
run-as com.dsh.android sh -c 'grep -a "MP-ALIGN" files/logs/web.log | tail -3'
```

把 `getBoundingClientRect()` 的 `width@left` 打出来，就知道真实结构了。

### 3.3 六轮实测（vw=394，dpr=3.25，1280×2772）

| 版本 | 做法 | 探针稳定态 | 截图（标题 / 列表左缘） |
|---|---|---|---|
| v1 | 无 | `HEADER:394@0 H1:100@88 UL:394@0` | 259px / 52px |
| v2 | `ul{pad}` `header{pad}` | `UL:394@0:pad16px` | 259px / **0px（更糟）** |
| v3 | `ul{margin}` `header{!important pad}` | `H1:100@52 UL:394@16` | — |
| v4 | **只抬 `main`/`section`** | `SECTION:362@16 UL:362@16` | 259px / **52px = 16dp ✓** |
| v5 | v4 + `header{flex-start}` | `HEADER:362@16 H1:100@104` | 标题**更右** |
| v6 | v5 + `h1{margin-left:0}` | `H1:100@104`（不变） | — |
| **v7 定位** | 父链探针 `[MP-CHAIN]` | 见下 | — |
| **v7 修法** | `header{padding-left:0}` | `padL:0px BUTTON:28@16 H1:100@52` | 标题行 **259px → 90px** ✓ |

### 3.3.1 标题偏右的真凶（父链探针，1.1.0-232 测得）

```text
HEADER(X_2TxG_moreHead) 362@16
  padding: 4px 12px 4px 52px        ← 就是这 52px
  display: flex; align-items: center
  kids: BUTTON(…_moreBack) 28@68    ← 返回箭头是 flex 子项，被 52px 一起推右
        H1(X_2TxG_pageTitle) 100@104
```

链上其它层全是 `padding:0` / `display:contents` / `grid`，**没有别的元素参与水平定位**。
所以：52（预留空位）+ 28（按钮）+ 8（间距）= H1 落在 104。

⇒ 修法只有一条：**把 `header` 的 `padding-left` 归零**（保留上/右/下）。

```js
header 且 宽 ≥ 50% 视口 且 文本含「插件」 → setProperty('padding-left', '0px', 'important')
```

修后探针：`padL:"0px" BUTTON:28@16 H1:100@52`；截图标题行左缘 259px → **90px**（左移 52dp），
列表左缘仍是 52px（16dp），两者落在同一视觉轴线上。

**结论（可直接复用）**：

- **列表贴边 ⇒ 抬最外层容器**（`main`/`section` 且 `width ≥ 90%vw`、`left ≤ 2` 时加 `padding:0 16px !important`）。
  父级一内缩，`header`/`ul`/`li` 全部跟着内缩，**不会叠加**。
- **`ul` 千万不要加 `padding`** —— 它只推 li 内容，`ul` 自己的底色/分隔线仍铺满，量出来比原来更贴边（0px）。
- **标题偏右 ⇒ 先 dump 父链看 `padding`**。别改 `justify-content`（主轴本来就靠左），别改 `h1{margin}`（H1 是 `flex:0 1 auto`，没有 auto margin）。
  官方给导航条留了 `padding-left:52px` 给返回按钮，按钮本身又是 flex 子项 —— 两处叠加才是 104 的来源。
- **改前先取证**：`console.log('[MP-CHAIN] ' + 父链)` → 落 `files/logs/web.log`；一次 dump 胜过六轮试错。

### 3.4 幂等纪律

每次改动都打标记（`data-mp-root` / `data-mp-pad` / `data-mp-head`），并在定时器里先查标记，
否则每 1.2s 加一次 padding，越跑越窄。

### 3.5 「标题向左瞬移」——补丁时机（1.1.0-234 → 237）

**现象**：从插件页进入「实验性插件」页时，标题会**极快地向左跳一下**。

**原因**：补丁是用 JS 定时器打的（`setTimeout(fix, 1200)`），
官方先用 `padding-left:52px` 画了第一帧，1.2 秒后才被改成 0 → 标题瞬移。

**试过但不行的方案**

| 方案 | 探针结果 | 结论 |
|---|---|---|
| CSS `header[class*="_moreHead"]{padding-left:0}` | `css:"on"` 但 `padL:"52px"` | **属性选择器不命中渲染**，CSS 这条路走不通 |
| `section:has(> header[class*="_moreHead"])` | `secPadL:"0px"` | 同上（且依赖 `:has()`） |

⇒ **DSH 的 CSS Modules 场景下，别指望用属性选择器覆盖官方规则；inline style 一定生效。**

**正确做法：MutationObserver + requestAnimationFrame**

```js
new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

var queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(function () { queued = false; patch(); });
}
```

- `MutationObserver` 回调在微任务里，早于下一帧 paint
- 包一层 `rAF` 合并同帧多次变更，且 **rAF 回调在 paint 之前**执行
- ⇒ 样式在**第一次绘制前**就已是 `padding-left:0`，用户看不到位移

**验收证据（逐帧采样 `H1.left`，写 `files/logs/web.log`）**

```text
[MP-MOTION] first left=32 padL=0px frame=1      ← 第 1 帧 padL 就是 0
[MP-MOTION] changed left=104 from=32 frame=268
[MP-MOTION] changed left=52 from=104 frame=269
```

`padL=0 from frame=1` ⇒ **补丁零延迟**。后续 `left` 数值波动是**官方页面转场时整体平移**
（整个 `header` 的 `left` 一起变），不是内部布局跳动。

采样的判读要点：**先看 `padL`，再看 `left`**。只看 `left` 会把转场动画误判成布局 bug。

**采样器本身的两个坑**

1. 不要用「总帧数上限」控制生命周期（`frames > 3000` ≈ 50 秒）。
   UI 子代理导航可能要 1 分多钟，等进到页面时采样器已经停了 —— 235 就是这样一条数据都没采到。
   ⇒ **只在目标页计帧**。
2. 页面重建后要重置「首帧」状态：连续 `miss > 3` 帧找不到标题 ⇒ `sawFirst = false`，
   这样才能对**每一次进入页面**都记录一条 `first`。


---

## 4. 真机验收的固定套路

```bash
# 1) 装热包
cp /sdcard/mNNN.zip /data/local/tmp/; chmod 644 /data/local/tmp/mNNN.zip
run-as com.dsh.android sh -c 'rm -f files/runtime/plugins/mobile-ui-1.1.0-*.zip; \
  cp /data/local/tmp/mNNN.zip files/runtime/plugins/mobile-ui-1.1.0-NNN.zip'
# 2) 重启（force-stop 才会重新解包插件）
am force-stop com.dsh.android; am start -n com.dsh.android/.MainActivity
# 3) 核对版本
run-as com.dsh.android cat files/home/.dsh/mobile-ui/dsh-android-mobile/.mobile_ui_version
# 4) 探针 / 截图量像素
run-as com.dsh.android sh -c 'grep -a "MP-ALIGN" files/logs/web.log | tail -2'
screencap -p /sdcard/x.png
```

量像素用 PIL：背景色取底部中间像素，逐行找左侧第一个「与背景差 > 阈值」的 x，
再除以 `1280/394 ≈ 3.25` 得到 dp；只有 dp 对得上（16dp ⇒ 52px）才算真生效。

---

## 5. 其它已知坑

- `super_admin::terminal`（双冒号）会 `Tool not found`，必须写 `super_admin:terminal`。
- `/sdcard` 对 `run-as` 不可写；中转走 `/data/local/tmp`（`shell` 可写，`chmod 644` 后 `run-as` 可读）。
- 在 shell heredoc 里写 JS/CSS 片段时，`for` / `if` / `var` / 制表符可能被吞，
  导致 `node --check` 报 `Unexpected token 'var'` ⇒ **用文件 API 写片段再 `cat` 追加**。
- `DshLog` 在子线程**不落盘**，需要 `runOnUiThread`。
