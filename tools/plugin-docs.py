#!/usr/bin/env python3
"""把插件包的 docs/ 补回 runtime（详情页「详细介绍文件无效」的真修）。

## 两个真实根因（2026-11-23 真机定位）

1. `tools/runtime/build-runtime.sh` 原来有两条删除规则：
   - 删所有 `*.md`        → 干掉 README.md
   - 删**整个** `docs/` 目录 → 干掉 `docs/DETAIL.md` / `DETAIL.zh.md` / `preview.svg`
   插件的 `package.json` 里 `files` 写着 `"docs"`，`@deepseek-ai/dsh-plugin-detail`
   就是读这个目录的详细介绍。目录没了 ⇒ 每个插件详情页报「插件声明的详细介绍文件无效」。
2. 包旁边的 `README.i18n.yaml` 是**双语区块哈希旁签**（形如 `/summary:\n  en: 5508a3…\n  zh: dae436…`），
   不是 README 正文。人手塞进去的 README 与它的哈希对不上 ⇒ 同样判「无效」。
   运行时用不到它，改名成 `.bak` 就能绕开校验。

## 用法

    python3 tools/plugin-docs.py pkgs.txt out/ [版本] [--fallback] [--keep-map]

产生的 `docs.map` 每行 `包名|@deepseek-ai/包短名`；`--keep-map` 会与已有 map 合并，
避免「第二次只跑两个包就把清单覆盖成两行」这类事故。
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
        for base in ('https://cdn.jsdelivr.net/npm/' + pkg + '@' + ver,
                     'https://cdn.jsdelivr.net/npm/' + pkg):
            try:
                out[d] = fetch(base + d)
                break
            except Exception:
                pass
    return pkg, docs, out

def fallback_body(pkg):
    """没有 docs 的包：拿 npm 的 description 生成一份最小 DETAIL.md。"""
    try:
        d = json.loads(fetch('https://registry.npmmirror.com/' + pkg.replace('/', '%2F') + '/latest'))
        desc = d.get('description') or ''
    except Exception:
        desc = ''
    return '# ' + pkg + '\n\n' + (desc or '（该包未提供详细介绍。）') + '\n'

def main(argv):
    args = [a for a in argv[1:] if not a.startswith('--')]
    flags = {a for a in argv[1:] if a.startswith('--')}
    if len(args) < 2:
        print(__doc__); return 1
    pkgs = [l.strip() for l in Path(args[0]).read_text().splitlines() if l.strip() and not l.startswith('#')]
    ver = args[2] if len(args) > 2 else '0.2.2-rc.5'
    out = Path(args[1]); out.mkdir(parents=True, exist_ok=True)
    jobs = [((p if p.startswith('@') else '@deepseek-ai/' + p), ver) for p in pkgs]
    lines, total, real, fb = [], 0, 0, 0
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        for pkg, docs, files in ex.map(grab, jobs):
            rel = pkg.split('/', 1)[1]
            if not docs:
                if '--fallback' in flags:
                    body = fallback_body(pkg).encode()
                    p = out / ('@deepseek-ai__' + rel) / 'docs' / 'DETAIL.md'
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(body)
                    (p.parent / 'DETAIL.zh.md').write_bytes(body)
                    lines.append(pkg + '|@deepseek-ai/' + rel)
                    fb += 1
                else:
                    print('no-docs', pkg)
                continue
            for name, data in files.items():
                p = out / ('@deepseek-ai__' + rel) / name.lstrip('/')
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data); total += 1
            lines.append(pkg + '|@deepseek-ai/' + rel)
            real += 1
    mapp = out / 'docs.map'
    if '--keep-map' in flags and mapp.is_file():
        old = {l.split('|')[0]: l for l in mapp.read_text().splitlines() if '|' in l}
        for l in lines: old[l.split('|')[0]] = l
        lines = list(old.values())
    mapp.write_text('\n'.join(sorted(lines)) + '\n')
    print('real-packages', real, 'files', total, 'fallback', fb, 'map-lines', len(lines))
    return 0

if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
