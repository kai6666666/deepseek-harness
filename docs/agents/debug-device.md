# 调试真机

> 本文是 [AGENTS.md](../../AGENTS.md) 的分册之一，
索引见 [docs/agents/README.md](README.md)。

## 调试真机

App 私有目录别的 UID 读不到，`adb shell ls` 会报 `inaccessible or not found`，必须走 `run-as`：

```powershell
adb shell run-as com.dsh.android ls -la files/engine
adb shell run-as com.dsh.android cat files/home/.dsh/profiles/web/package.json
```

**定位 WebView 内布局问题的方法**（本轮就是这么做出来的）：插件 `client.js` 是明文，
可以直接往里追加探针代码再推回设备——

```powershell
adb push probe.js /sdcard/p.js
adb shell run-as com.dsh.android cp /sdcard/p.js `
  files/home/.dsh/mobile-ui/dsh-android-mobile/lib/client.js
adb shell am force-stop com.dsh.android   # 重启才会重新加载
```

`console.log` 会经 `[web]` 前缀出现在 logcat 里。用
`getBoundingClientRect()` / `getComputedStyle()` / `elementsFromPoint()` 拿数值证据，
比反复截图猜快得多。

⚠️ **探针用完必须删干净**：`run-as rm -rf` 掉整个插件目录（让它从 APK 重新解包），
并清 `/sdcard` 上的临时文件。否则下次构建的资产版本戳虽然会覆盖它，但中途容易被自己误导。

