#!/usr/bin/env python3
"""把 DSH 官方版本号写进三处真源，声称一次改完。

真源本身仍是 tools/engine-version.txt；本脚本只负责同步它与
app/build.gradle.kts、tools/app-version.txt，避免手改漏一处。

用法：
  python3 tools/sync-dsh-version.py --npm next
  python3 tools/sync-dsh-version.py --npm latest
  python3 tools/sync-dsh-version.py --version 0.2.2-rc.3
  可加 --dry-run 只看不改，--keep-code 不递增 versionCode
"""
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
NPM = "https://registry.npmjs.org/@deepseek-ai%2Fdsh"
args = sys.argv[1:]
DRY = "--dry-run" in args
KEEP = "--keep-code" in args


def opt(name):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            return args[i + 1]
    return None


ver = opt("--version")
chan = opt("--npm")
if not ver and chan:
    with urllib.request.urlopen(NPM, timeout=25) as r:
        tags = json.load(r)["dist-tags"]
    ver = tags.get(chan)
    print(f"npm dist-tags: {tags}")
if not ver:
    sys.exit("需要 --version X 或 --npm latest|next")

gradle = ROOT / "app/build.gradle.kts"
gt = gradle.read_text(encoding="utf-8")
m_name = re.search(r'^(\s*)versionName\s*=\s*"([^"]+)"', gt, re.M)
m_code = re.search(r'^(\s*)versionCode\s*=\s*(\d+)', gt, re.M)
if not m_name or not m_code:
    sys.exit("解析 gradle versionName/versionCode 失败")
old_ver, old_code = m_name.group(2), int(m_code.group(2))
new_code = old_code if KEEP else old_code + 1

print(f"engine-version  {ver}")
print(f"versionName     {old_ver} → {ver}")
print(f"versionCode     {old_code} → {new_code}" + ("（--keep-code）" if KEEP else ""))

gt2 = re.sub(r'^(\s*)versionName\s*=\s*"[^"]+"', lambda m: f'{m.group(1)}versionName = "{ver}"', gt, count=1, flags=re.M)
gt2 = re.sub(r'^(\s*)versionCode\s*=\s*\d+', lambda m: f'{m.group(1)}versionCode = {new_code}', gt2, count=1, flags=re.M)

files = {
    "tools/engine-version.txt": ver + "\n",
    "tools/app-version.txt": f"versionName={ver}\nversionCode={new_code}\n",
    "app/build.gradle.kts": gt2,
}
if DRY:
    for k in files:
        print(f"[dry-run] 将写 {k}")
    sys.exit(0)
for rel, text in files.items():
    (ROOT / rel).write_text(text, encoding="utf-8")
    print(f"✅ 写入 {rel}")
print("下一步：python3 tools/check-version-alignment.py --npm 复核，然后提交")
