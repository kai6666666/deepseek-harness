# ⑦ 文件选择器 / ⑦.5 下载器

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

### ⑦ WebView 默认没有文件选择器 —— 必须实现 `onShowFileChooser`

**症状**：composer 里点「+」→「文件」，**静默无反应**，没有报错、没有日志。

**根因**：`WebChromeClient` 只覆写了 `onConsoleMessage`，没覆写 `onShowFileChooser`。
WebView 的默认实现**立刻回调 `onReceiveValue(null)`**（即"用户没选任何文件"），
于是页面认为选择被取消，什么都不发生。页面里确实有
`<input type="file" multiple hidden>`（`.uV2eYG_tools` 内），走的就是标准 file chooser。

⚠️ 该页面**没有** File System Access API（`showOpenFilePicker` / `showSaveFilePicker` /
`showDirectoryPicker` 全是 `undefined`），所以不需要实现 `onShowFilePicker`（WebView 113+
的新接口）；`onShowFileChooser` 才是正确的接缝。

**做法**（`MainActivity.kt`）：用 `registerForActivityResult(StartActivityForResult)`
拉起 `fileChooserParams.createIntent()`，按 `mode == MODE_OPEN_MULTIPLE` 补
`EXTRA_ALLOW_MULTIPLE`，结果里优先取 `clipData`（多选）再退回 `data.data`（单选）。

⚠️ **取消时必须回调 `null`，不能回调空数组** —— 空数组会被页面解读成"选了 0 个文件"
而触发一次空提交。`ActivityNotFoundException`（无任何应用能处理）同样要 `null` 并返回 `false`。
⚠️ 回调是**一次性**的：`filePathCallbackRef` 要在调用前取出并置空，否则第二次点击不会响应。

### ⑦.5 WebView 默认没有下载器 —— 必须实现 `setDownloadListener`

**症状**：composer 里 `/export`（下载日志）或顶栏「下载 Session 日志」**声称成功**
（界面显示"已保存"），但 `/sdcard/Download/` 下**没有文件**，也没有任何报错。

**根因与 ⑦ 同构**：`WebView` 默认的 `DownloadListener` 是 **no-op** ——
页面用 `<a download>` + `anchor.click()` 触发下载时，WebView 什么都不做。
`dsh-session-log-export/lib/client.js` 的 `downloadUrl()` 走的正是这条路：

```js
const anchor = document.createElement("a");
anchor.href = url; anchor.download = filename; anchor.click();
```

⚠️ **`MainActivity` 从来没有 `setDownloadListener`**（`grep` + `git log -S` 全历史
确认过，不是回归而是从未实现）。所以这一处和 ⑦ 一样属于「默认实现静默失败」。

⚠️ **不要用系统 `DownloadManager`。** 试过，三个理由都不成立：
1. 它跑在**系统进程**里，**不共享 WebView 的 cookie jar**；
2. API 28+ 会**剥掉**应用自带的 `Cookie` 头；
3. 而 `/api/session.export` 是**纯 cookie 鉴权**（带 cookie → `200`，不带 → `401`）。

**做法**（`MainActivity.kt`）：`setDownloadListener { url, userAgent, contentDisposition,
mimeType, _ -> handleDownload(...) }`，`handleDownload()` 在**本进程内**用
`HttpURLConnection` 发 GET，手动带上三样东西：

| 头 | 值 |
|---|---|
| `Cookie` | `CookieManager.getInstance().getCookie(url)` |
| `User-Agent` | WebView 传进来的 `userAgent` |
| `Referer` | `http://127.0.0.1:3080/` |

`connectTimeout 15_000` / `readTimeout 60_000`，`responseCode != HTTP_OK` 直接
`error("HTTP $code")`，`finally { conn.disconnect() }`，落盘后
`withContext(Dispatchers.Main)` 弹 toast。

⚠️ **只处理 `http://127.0.0.1` 的 URL**，其余（`blob:`/`data:`/外链）交给系统浏览器
（`Intent.ACTION_VIEW`）—— 本 App 的下载全部来自内置引擎，外链走系统更合适。

⚠️ 文件名用 `URLUtil.guessFileName(url, contentDisposition, mimeType)`。

**落盘位置**（`downloadTargetDir()`）：有 `WRITE_EXTERNAL_STORAGE` 时用
`Environment.getExternalStoragePublicDirectory(DIRECTORY_DOWNLOADS)`（即
`/sdcard/Download/`），否则退回 `getExternalFilesDir(DIRECTORY_DOWNLOADS) ?: filesDir`。

**真机验收**（`/export` 全链路）：

```
/sdcard/Download/dsh-session-session-dff05b44-baa3-47b2-8dd7-71d90c6c4ba9.zip  665 B
日志：Session 日志已保存: /storage/emulated/0/Download/...（665 字节）
```

把 zip 拉回 PC 用 `ZipFile` 打开 → 1 个条目 `session.v4.jsonl`（1457 B），
魔数 `PK\x03\x04` ✅。

