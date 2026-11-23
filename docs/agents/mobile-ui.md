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
# 改前（两处都会踩）
find … -name '*.md' -delete                 # 干掉 README.md
find … -type d \( -name docs -o -name … \) -delete   # 干掉整个 docs/  ← 真凶
```

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
| **v6 收敛** | **只保留 v4** | `SECTION:362@16 UL:362@16` | 列表 16dp ✓，标题回退原样 |

**结论（可直接复用）**：

- **列表贴边 ⇒ 抬最外层容器**（`main`/`section` 且 `width ≥ 90%vw`、`left ≤ 2` 时加 `padding:0 16px !important`）。
  父级一内缩，`header`/`ul`/`li` 全部跟着内缩，**不会叠加**。
- **`ul` 千万不要加 `padding`** —— 它只推 li 内容，`ul` 自己的底色/分隔线仍铺满，量出来比原来更贴边（0px）。
- **标题不能靠 padding 推**（会把返回箭头一起推右）；`flex-start` 也不够，H1 外面还有一层包裹，
  `margin-left:0` 无效 ⇒ **待办**：需要定位 `H1` 与 `header` 之间那一层元素（下一步 dump `H1.parentElement` 的完整链）。

### 3.4 幂等纪律

每次改动都打标记（`data-mp-root` / `data-mp-pad` / `data-mp-fix`），并在 `setInterval` 里先查标记，
否则每 1.2s 加一次 padding，越跑越窄。

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
