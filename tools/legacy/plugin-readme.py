#!/usr/bin/env python3
"""把插件包的 README.md 找回来。

原因：`tools/runtime/build-runtime.sh:397` 为减包删掉了 node_modules 里所有 `.md`，
而 `@deepseek-ai/dsh-plugin-detail` 只认 `README.md` / `readme.md`，
于是每个插件详情页都报「插件声明的详细介绍文件无效」。
（包里的 `README.i18n.yaml` 只是双语区块哈希旁签，没有正文，不能拿来转。）

策略：jsDelivr 取原文 → npm packument 的 readme → 都没有就用 description 生成最小版。
产物：`<out>/<扁平路径>/README.md` + `<out>/readme.map`（每行 `包名|相对包目录`）。
"""
import concurrent.futures as cf
import json, sys, urllib.request
from pathlib import Path

UA = {'User-Agent': 'dsh-android-readme-fetch'}

def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def try_jsdelivr(pkg):
    for name in ('README.md', 'readme.md'):
        for verpart in ('@latest', ''):
            try:
                d = fetch('https://cdn.jsdelivr.net/npm/' + pkg + verpart + '/' + name)
                if d and len(d) > 40:
                    return d.decode('utf-8', 'replace')
            except Exception:
                pass
    return None

def try_packument(pkg):
    for base in ('https://registry.npmmirror.com/', 'https://registry.npmjs.org/'):
        try:
            doc = json.loads(fetch(base + pkg.replace('/', '%2F')))
            t = doc.get('readme') or ''
            if len(t) > 40:
                return t
        except Exception:
            pass
    return None

def minimal(pkg):
    desc = ''
    try:
        doc = json.loads(fetch('https://registry.npmmirror.com/' + pkg.replace('/', '%2F') + '/latest'))
        desc = (doc.get('description') or '').strip()
    except Exception:
        pass
    return '# ' + pkg + '\n\n' + (desc or '（该包未提供 README，此文件为占位，保证插件详情页能正常打开。）') + '\n'

def one(pkg):
    txt = try_jsdelivr(pkg) or try_packument(pkg)
    if not txt:
        txt = minimal(pkg)
    return pkg, txt

def main(argv):
    names = [l.strip() for l in Path(argv[1]).read_text().splitlines()
             if l.strip() and not l.strip().startswith('#')]
    jobs = []
    for n in names:
        jobs.append(('@deepseek-ai/' + n, '@deepseek-ai/' + n))
    out = Path(argv[2]); out.mkdir(parents=True, exist_ok=True)
    lines = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for pkg, txt in ex.map(lambda j: one(j[0]), jobs):
            rel = pkg.split('/', 1)[1]
            d = out / ('@deepseek-ai__' + rel)
            d.mkdir(parents=True, exist_ok=True)
            (d / 'README.md').write_text(txt)
            lines.append(pkg + '|@deepseek-ai/' + rel)
            print('ok', pkg, len(txt))
    (out / 'readme.map').write_text('\n'.join(lines) + '\n')
    print('total', len(lines))

if __name__ == '__main__':
    main(sys.argv)
