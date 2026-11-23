#!/usr/bin/env python3
"""runtime 分块清单 + 文件级差分（P2）。

为什么需要：
  runtime 是 4 个 `rootfs-*.tar.xz` 分片（合计约 145 MB）。现在只要引擎版本变一次，
  App 就得把 4 片全部重下 —— 但真机实测两版之间往往只差**几十字节**
  （debug.27 vs debug.28：`rootfs-part2` 783156 → 783204，差 48 B，其余三片字节级相同）。

做法：
  ① `manifest <dir>`：把每个分片切成固定 64 KiB 块，逐块记 sha256 + 偏移 + 长度，
     产出 `runtime-chunks.json`（跟着 runtime 一起发到 Release）。
  ② `diff <old.json> <new.json>`：对比两份清单，输出「需要下载的块」——
     客户端只对这些块发 HTTP Range 请求，其余块从本地旧文件按偏移拷过来。
  ③ `verify <manifest> <dir>`：校验本地目录里的文件与清单一致（防止半包）。

约定：
  · 块大小固定 `CHUNK`，**不要改**——改了旧客户端算不出偏移。
  · 清单里 `sha256` 是**整文件**哈希，用于重组后终校；`chunks[].h` 是块哈希。
"""
import hashlib
import json
import sys
from pathlib import Path

CHUNK = 64 * 1024  # 64 KiB：真机实测分片差异常只有几十字节，1 MiB 会白下 1 MB；64 KiB 时 manifest 约 200 KB，可接受

def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def chunk_hashes(path: Path):
    out = []
    with path.open('rb') as f:
        off = 0
        while True:
            data = f.read(CHUNK)
            if not data:
                break
            out.append({'o': off, 'l': len(data), 'h': hashlib.sha256(data).hexdigest()})
            off += len(data)
    return out

def build(directory: Path):
    entries = {}
    for p in sorted(directory.glob('rootfs*.tar.xz')):
        entries[p.name] = {
            'bytes': p.stat().st_size,
            'sha256': sha_file(p),
            'chunk': CHUNK,
            'chunks': chunk_hashes(p),
        }
        print(f'  {p.name}: {p.stat().st_size} B / {len(entries[p.name]["chunks"])} chunks', file=sys.stderr)
    return {'chunkSize': CHUNK, 'files': entries}

def cmd_manifest(directory: Path, out: Path):
    doc = build(directory)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    total = sum(len(v['chunks']) for v in doc['files'].values())
    print(f'{out}: {len(doc["files"])} files / {total} chunks')

def cmd_diff(old_path: Path, new_path: Path):
    old = json.loads(old_path.read_text())
    new = json.loads(new_path.read_text())
    total_bytes = 0
    total_chunks = 0
    need_bytes = 0
    need_chunks = 0
    for name, nf in new['files'].items():
        total_bytes += nf['bytes']
        total_chunks += len(nf['chunks'])
        of = (old.get('files') or {}).get(name)
        if of is None:
            need_bytes += nf['bytes']
            need_chunks += len(nf['chunks'])
            print(f'  {name}: 新文件 → 全量 {nf["bytes"]} B')
            continue
        if of.get('sha256') == nf.get('sha256'):
            print(f'  {name}: 完全相同 → 0 B')
            continue
        # 同序比块（分片只会在尾部增长，长度变化不影响前面块的偏移）
        old_h = [c['h'] for c in of['chunks']]
        changed = [c for i, c in enumerate(nf['chunks']) if i >= len(old_h) or old_h[i] != c['h']]
        b = sum(c['l'] for c in changed)
        need_bytes += b
        need_chunks += len(changed)
        print(f'  {name}: {len(changed)}/{len(nf["chunks"])} 块变化 → {b} B')
    saved = 1 - (need_bytes / total_bytes if total_bytes else 1)
    print('---')
    print(f'总计      {total_bytes} B / {total_chunks} 块')
    print(f'需下载    {need_bytes} B / {need_chunks} 块')
    print(f'节省      {saved * 100:.4f}%  （{total_bytes - need_bytes} B 不必下载）')

def cmd_verify(manifest: Path, directory: Path):
    doc = json.loads(manifest.read_text())
    bad = 0
    for name, meta in doc['files'].items():
        p = directory / name
        if not p.is_file():
            print(f'MISSING {name}')
            bad += 1
            continue
        if p.stat().st_size != meta['bytes']:
            print(f'SIZE {name} {p.stat().st_size} != {meta["bytes"]}')
            bad += 1
            continue
        if sha_file(p) != meta['sha256']:
            print(f'SHA {name}')
            bad += 1
    print('OK' if bad == 0 else f'{bad} 项不一致')
    return 1 if bad else 0

def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]
    if cmd == 'manifest':
        cmd_manifest(Path(argv[2]), Path(argv[3]) if len(argv) > 3 else Path('runtime-chunks.json'))
    elif cmd == 'diff':
        cmd_diff(Path(argv[2]), Path(argv[3]))
    elif cmd == 'verify':
        return cmd_verify(Path(argv[2]), Path(argv[3]))
    else:
        print(__doc__)
        return 2
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))
