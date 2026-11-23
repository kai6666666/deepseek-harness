#!/usr/bin/env python3
"""把插件包的 docs/ 目录找回来（详情页「详细介绍文件无效」的真正修法）。

build-runtime.sh 除了删 *.md，还删整个 docs 目录：
  find "$ROOTFS/opt/dsh/node_modules" -type d \\( -name test -o -name docs -o -name example ... \\) -delete
而插件 package.json 的 files 里明写着 "docs"——dsh-plugin-detail 就是去 docs/ 读详细介绍。
"""
import concurrent.futures as cf
import json, sys, urllib.request
from pathlib import Path

UA = {'User-Agent': 'dsh-android-docs-fetch'}

def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def list_docs(pkg, ver):
    for base in ('https://data.jsdelivr.com/v1/packages/npm/' + pkg + '@' + ver + '?structure=flat',
                 'https://data.jsdelivr.com/v1/packages/npm/' + pkg + '?structure=flat'):
        try:
            doc = json.loads(fetch(base))
            files = [f['name'] for f in doc.get('files', []) if f.get('type', 'file') == 'file']
            return [f for f in files if f.startswith('/docs/')]
        except Exception:
            continue
    return []

def grab(job):
    pkg, ver = job
    docs = list_docs(pkg, ver)
    out = {}
    for d in docs:
        for base in ('https://cdn.jsdelivr.net/npm/' + pkg + '@' + ver, 'https://cdn.jsdelivr.net/npm/' + pkg):
            try:
                out[d] = fetch(base + d)
                break
            except Exception:
                pass
    return pkg, docs, out

def main(argv):
    pkgs = [l.strip() for l in Path(argv[1]).read_text().splitlines() if l.strip()]
    ver = argv[3] if len(argv) > 3 else '0.2.2-rc.5'
    out = Path(argv[2]); out.mkdir(parents=True, exist_ok=True)
    jobs = [((p if p.startswith('@') else '@deepseek-ai/' + p), ver) for p in pkgs]
    lines = []; total = 0
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for pkg, docs, files in ex.map(grab, jobs):
            if not docs:
                print('no-docs', pkg); continue
            rel = pkg.split('/', 1)[1]
            for name, data in files.items():
                p = out / ('@deepseek-ai__' + rel) / name.lstrip('/')
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data); total += 1
            lines.append(pkg + '|@deepseek-ai/' + rel)
            print('ok', pkg, len(files), 'files')
    (out / 'docs.map').write_text('\n'.join(lines) + '\n')
    print('packages', len(lines), 'files', total)

if __name__ == '__main__':
    main(sys.argv)
