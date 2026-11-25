#!/usr/bin/env python3
"""Expose plugin-market failure reasons in the browser console.

Consumes `pm-client.js` (a copy of
`dsh-client-ui-plugin-market/lib/client.js`) and patches the `saveSources`
failure branch so the **real** `error.message` reaches the console (and thus
logcat, tag `chromium`).

Why: `sourceFailure()` collapses every unexpected error into
`kind: 'other'`, which the UI renders as a bare 无法保存索引源. That text
tells the user nothing and told us nothing either -- the first round of
diagnosis had to be done by reading the minified client back-to-front.
One `console.error` there would have answered it in one restart.

Usage:
    python3 tools/pm-console-probe.py --in /tmp/pm-client.js --out /tmp/pm-client.patched.js
    python3 tools/pm-console-probe.py --in client.js --check   # 只检查是否已打过

The patch is idempotent: running it twice does not double-inject.

⚠️ 第一版这里用了 `catch(_){},` —— 块语句后接逗号是 **JS 语法错误**，整个
client.js 会加载失败，表现为「发现」Tab 直接消失（比原来的 bug 更糟）。
教训：注入到压缩后的 JS 里，语句之间只能用 `;`，不能用逗号表达式跨块。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 打点后的形态：在 return 之前把 failure 整个打出来
MARKER = '"[pm-probe] saveSources failed"'

ORIGINAL = (
    "if(!answer.ok){this.selectAdded=false;"
    "this.patch({saving:false,sourceFailure:sourceFailure(answer.error)});return}"
)

PATCHED = (
    "if(!answer.ok){"
    "try{console.error(" + MARKER + ","
    "JSON.stringify({code:answer.error&&answer.error.code,"
    "message:answer.error&&answer.error.message,"
    "details:answer.error&&answer.error.details}))}catch(_){};"
    "this.selectAdded=false;"
    "this.patch({saving:false,sourceFailure:sourceFailure(answer.error)});return}"
)


def find_candidates(src: str) -> list[str]:
    """Return every `saveSources` failure branch we can see (whitespace-tolerant)."""
    hits = []
    for m in re.finditer(r"if\(!answer\.ok\)\{", src):
        hits.append(src[m.start():m.start() + 200])
    return hits


def patched_already(src: str) -> bool:
    return MARKER in src


def apply_patch(src: str) -> tuple[str, str]:
    if patched_already(src):
        return src, 'already-patched'
    if ORIGINAL in src:
        return src.replace(ORIGINAL, PATCHED, 1), 'exact'
    # 退化路径：用正则匹配「if(!answer.ok){」到「return}」这一小段，
    # 保留其中原有的语句，只在最前面插入 console.error。
    pat = re.compile(
        r"if\(!answer\.ok\)\{(?P<body>[^{}]{0,400}?)return\}",
        re.S,
    )
    m = pat.search(src)
    if not m:
        return src, 'not-found'
    body = m.group('body')
    inj = (
        "if(!answer.ok){"
        "try{console.error(" + MARKER + ","
        "JSON.stringify({code:answer.error&&answer.error.code,"
        "message:answer.error&&answer.error.message,"
        "details:answer.error&&answer.error.details}))}catch(_){};"
        + body + "return}"
    )
    return src[:m.start()] + inj + src[m.end():], 'regex'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--in', dest='src', required=True, help='原始 client.js')
    ap.add_argument('--out', dest='dst', help='输出路径（不给则原地覆盖）')
    ap.add_argument('--check', action='store_true', help='只检查是否已打过，不写文件')
    args = ap.parse_args()

    src_path = Path(args.src)
    src = src_path.read_text(encoding='utf-8')

    if args.check:
        print('patched:', patched_already(src))
        for i, c in enumerate(find_candidates(src), 1):
            print('  candidate %d: %s' % (i, c[:120].replace('\n', ' ')))
        return 0

    out, how = apply_patch(src)
    print('patch mode:', how)
    if how == 'not-found':
        print('⚠️ 没找到 saveSources 的失败分支 —— 客户端结构可能变了，先 --check 看一眼')
        return 2
    if how == 'already-patched':
        print('已经是打过的版本，无需重复注入')
        return 0

    dst = Path(args.dst) if args.dst else src_path
    dst.write_text(out, encoding='utf-8')
    print('written:', dst, len(out), 'chars')
    print('注入点预览:')
    i = out.find(MARKER)
    print('  ' + out[max(0, i - 160):i + 260].replace('\n', ' '))
    return 0


if __name__ == '__main__':
    sys.exit(main())