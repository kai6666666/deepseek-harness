#!/usr/bin/env python3
"""Render DSH boot waterfalls from app.log / events.jsonl.

`BootTimeline.dump()` writes one block per launch:

    boot.timeline  total=46720ms
      runtime           0ms  Δ     0ms
      preflight      1021ms  Δ  1021ms  ██
      prootSpawn     1088ms  Δ    67ms  ▏
      nodeExec      44180ms  Δ 43092ms  ████████...
      health        46718ms  Δ  2538ms  ██

This script parses those blocks (plus `boot.timeline` events from
events.jsonl, which only carry `total`) and prints:

  * a single launch as an aligned waterfall with percentage shares
  * `--all`  every launch found in the file, side by side-ish (one row each)
  * `--json` machine-readable summary

Usage:
    python3 tools/startup-timeline.py app.log
    python3 tools/startup-timeline.py app.log --all
    python3 tools/startup-timeline.py app.log --last 3 --json

Exit codes: 0 ok, 1 no data found, 2 bad input.

Why a separate tool instead of reading the log by eye: the interesting
question is never "how long did this one launch take" but "which phase moved",
and that needs the phases side by side across launches.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

TS = re.compile(r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})')
HEAD = re.compile(r'boot\.timeline\s+total=(-?\d+)ms')
ROW = re.compile(r'^\s+(\S+)\s+(-?\d+)ms\s+Δ\s+(-?\d+)ms')


def parse_log(path: Path) -> list[dict]:
    """Return [{ts, total, rows:[{name, at, delta}]}] in file order."""
    launches: list[dict] = []
    cur: dict | None = None
    pending_ts: str | None = None

    for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
        m = TS.match(raw)
        if m:
            pending_ts = m.group(1)
            line = raw[m.end():]
        else:
            line = raw

        h = HEAD.search(line)
        if h:
            cur = {'ts': pending_ts, 'total': int(h.group(1)), 'rows': []}
            launches.append(cur)
            continue

        if cur is not None:
            r = ROW.match(line)
            if r:
                cur['rows'].append({
                    'name': r.group(1),
                    'at': int(r.group(2)),
                    'delta': int(r.group(3)),
                })
                continue
            # 空行或非行内容结束当前块（但下一行可能还是本块，宽松处理）
            if line.strip() and not line.startswith('  '):
                cur = None
    return launches


def parse_events(path: Path) -> list[dict]:
    """`events.jsonl` 里只有 total，没有分段；用来补「最后一次启动」的总时长。"""
    out = []
    if not path.is_file():
        return out
    for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except Exception:
            continue
        if ev.get('event') == 'boot.timeline' or ev.get('name') == 'boot.timeline':
            out.append(ev)
    return out


def render_one(launch: dict) -> str:
    total = launch['total'] or 1
    rows = launch['rows']
    out = []
    out.append('launch %s   total=%dms' % (launch['ts'] or '(no ts)', launch['total']))
    if not rows:
        out.append('  (无分段打点 —— 这版 BootTimeline 还没跑起来?)')
        return '\n'.join(out)
    name_w = max(len(r['name']) for r in rows)
    longest = max((r['delta'] for r in rows), default=1) or 1
    for r in rows:
        pct = 100.0 * r['delta'] / total
        cells = int(round(40.0 * r['delta'] / longest))
        out.append('  %-*s %7dms  Δ%7dms  %5.1f%%  %s' % (
            name_w, r['name'], r['at'], r['delta'], pct,
            ('█' * cells) if r['delta'] > 0 else '',
        ))
    return '\n'.join(out)


def render_all(launches: list[dict]) -> str:
    # 收集所有出现过的点名，按第一次出现的顺序
    names: list[str] = []
    for l in launches:
        for r in l['rows']:
            if r['name'] not in names:
                names.append(r['name'])
    if not names:
        return '(无分段数据)'
    name_w = max(len(n) for n in names)
    out = ['%-*s %8s %s' % (name_w, 'phase', 'total', ' '.join(
        '#%d' % (i + 1) for i in range(len(launches))))]
    out.append('-' * (name_w + 10 + 8 * len(launches)))
    for n in names:
        cells = []
        for l in launches:
            hit = next((r['delta'] for r in l['rows'] if r['name'] == n), None)
            cells.append('%7s' % ('-' if hit is None else str(hit)))
        out.append('%-*s %8s %s' % (name_w, n, '', ' '.join(cells)))
    out.append('')
    out.append('%-*s %8s %s' % (name_w, '(total)', '', ' '.join(
        '%7d' % l['total'] for l in launches)))
    return '\n'.join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('log', help='app.log 路径')
    ap.add_argument('--events', help='events.jsonl 路径（可选，只用来补 total）')
    ap.add_argument('--all', action='store_true', help='列出文件里所有启动')
    ap.add_argument('--last', type=int, default=1, help='只看最后 N 次（默认 1）')
    ap.add_argument('--json', action='store_true', help='输出 JSON')
    args = ap.parse_args()

    p = Path(args.log)
    if not p.is_file():
        print('no such file:', p, file=sys.stderr)
        return 2

    launches = parse_log(p)
    if not launches:
        print('没有找到 boot.timeline 块。')
        print('提示：这一版 APK 可能还没有 BootTimeline；或日志被轮转掉了。')
        if args.events:
            evs = parse_events(Path(args.events))
            if evs:
                print('events.jsonl 里有 %d 条 boot.timeline 事件（只有 total）：' % len(evs))
                for e in evs[-5:]:
                    print('  ', json.dumps(e, ensure_ascii=False)[:160])
        return 1

    sel = launches if args.all else launches[-args.last:]

    if args.json:
        print(json.dumps(sel, ensure_ascii=False, indent=2))
        return 0

    if args.all and len(sel) > 1:
        print(render_all(sel))
        print()
    for l in sel:
        print(render_one(l))
        print()
    return 0


if __name__ == '__main__':
    sys.exit(main())