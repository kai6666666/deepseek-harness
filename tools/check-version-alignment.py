#!/usr/bin/env python3
"""版本对齐闸门：DSH 官方版本号（@deepseek-ai/dsh）为唯一真源。

对齐关系（任一不符即 exit 1）：
  tools/engine-version.txt            == app/build.gradle.kts  versionName
  tools/app-version.txt versionName   == app/build.gradle.kts  versionName
  tools/app-version.txt versionCode   == app/build.gradle.kts  versionCode
  EngineManager.MOBILE_UI_VERSION     == tools/mobile-ui-version.txt

用法：
  python3 tools/check-version-alignment.py              # 本地 / CI 同款
  python3 tools/check-version-alignment.py --npm        # 附带 npm 官方 dist-tags 比对
  python3 tools/check-version-alignment.py --strict-npm # 官方 latest 已前进则直接失败
"""
import json
import os
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CI = bool(os.environ.get("GITHUB_ACTIONS"))
NPM = "https://registry.npmjs.org/@deepseek-ai%2Fdsh"
WANT_NPM = "--npm" in sys.argv or "--strict-npm" in sys.argv
STRICT_NPM = "--strict-npm" in sys.argv

fails = []
rows = []


def bad(msg):
    fails.append(msg)
    print(("::error::" if CI else "❌ ") + msg)


def readable(p):
    try:
        return (ROOT / p).read_text(encoding="utf-8")
    except FileNotFoundError:
        bad(f"缺少文件 {p}")
        return ""


def one(pattern, text, what):
    m = re.search(pattern, text, re.M)
    if not m:
        bad(f"解析不出 {what}")
        return None
    return m.group(1)


g = readable("app/build.gradle.kts")
g_name = one(r'^\s*versionName\s*=\s*"([^"]+)"', g, "gradle versionName")
g_code = one(r'^\s*versionCode\s*=\s*(\d+)', g, "gradle versionCode")

eng_txt = readable("tools/engine-version.txt").strip()
app_txt = readable("tools/app-version.txt")
a_name = one(r'^versionName=(\S+)', app_txt, "app-version versionName")
a_code = one(r'^versionCode=(\d+)', app_txt, "app-version versionCode")

km = readable("app/src/main/java/com/dsh/android/EngineManager.kt")
k_ui = one(r'MOBILE_UI_VERSION\s*=\s*"([^"]+)"', km, "EngineManager.MOBILE_UI_VERSION")
ui_txt = readable("tools/mobile-ui-version.txt").strip()

rows.append(("engine-version.txt", eng_txt))
rows.append(("gradle versionName", g_name or "?"))
rows.append(("app-version.txt", a_name or "?"))
rows.append(("gradle versionCode", g_code or "?"))
rows.append(("app-version.txt vc", a_code or "?"))
rows.append(("mobile-ui-version.txt", ui_txt))
rows.append(("EngineManager 戳", k_ui or "?"))

if g_name and eng_txt and g_name != eng_txt:
    bad(f"gradle versionName({g_name}) ≠ tools/engine-version.txt({eng_txt})")
if g_name and a_name and g_name != a_name:
    bad(f"gradle versionName({g_name}) ≠ tools/app-version.txt versionName({a_name})")
if g_code and a_code and g_code != a_code:
    bad(f"gradle versionCode({g_code}) ≠ tools/app-version.txt versionCode({a_code})")
if k_ui and ui_txt and k_ui != ui_txt:
    bad(f"EngineManager.MOBILE_UI_VERSION({k_ui}) ≠ tools/mobile-ui-version.txt({ui_txt})")

npm_latest = npm_next = None
if WANT_NPM:
    try:
        with urllib.request.urlopen(NPM, timeout=20) as r:
            tags = json.load(r)["dist-tags"]
        npm_latest, npm_next = tags.get("latest"), tags.get("next")
        print(f"npm @deepseek-ai/dsh  latest={npm_latest}  next={npm_next}")
        if npm_latest and eng_txt and npm_latest != eng_txt:
            msg = f"官方 latest({npm_latest}) ≠ 引擎版本({eng_txt})，需要时跑 tools/sync-dsh-version.py --npm latest"
            if STRICT_NPM:
                bad(msg)
            else:
                print(("::warning::" if CI else "⚠️ ") + msg)
    except Exception as e:  # 网络失败不阻断构建
        print(("::warning::" if CI else "⚠️ ") + f"npm 官方版本查询失败：{e}")

print("\n| 项 | 值 |\n|---|---|")
for k, v in rows:
    print(f"| {k} | `{v}` |")
if npm_latest:
    print(f"| npm latest | `{npm_latest}` |")

if fails:
    print(f"\n版本对齐失败：{len(fails)} 项")
    sys.exit(1)
print(f"\n✅ 版本对齐：{eng_txt}（engine / versionName / app-version 三者一致）")
