#!/usr/bin/env python3
"""B 阶段第 2 层分析器：ESM loader 时间线 + V8 CPU profile。

    python3 tools/boot-timing-esm.py --esm files/logs/boot-timing-esm.log
        · resolve/load 事件总量与最慢单模块
        · **相邻事件间隙**：间隙 = 上一个模块的求值/初始化成本
          （`listen → listening` 那 13 s 就藏在这里）
        · 按 package 聚合 load 耗时

    python3 tools/boot-timing-esm.py --prof CPU.*.cpuprofile [--top 25]
        · 按 function 聚合 self time（V8 采样 1 ms）
        · 按 package 聚合，给出「到底谁在烧那 13 秒」

数据来源：`app/src/main/java/com/dsh/android/runtime/BootTimingPreload.kt`
里的 `SCRIPT_ESM` / `SCRIPT_HOOKS`（`--import` + `module.register()`），
profile 由 `--cpu-prof --cpu-prof-interval=1000` 写到 `$DSH_HOME/cpuprof/`。
"""

import json
import os
import re
import sys
from collections import defaultdict

EVENT_RE = re.compile(r'^(resolve|load) t=(\d+) ms=([0-9.]+) (.*)$')


def package_of(url):
    if not url:
        return '(native)'
    if url.startswith('node:'):
        return 'node:builtin'
    i = url.rfind('node_modules/')
    if i < 0:
        return '(self)'
    rest = url[i + len('node_modules/'):]
    part = rest.split('/')[0]
    if part.startswith('@') and '/' in rest:
        part = '/'.join(rest.split('/')[:2])
    return part


def analyze_esm(path, top=15):
    events = []
    for line in open(path, encoding='utf-8', errors='replace'):
        m = EVENT_RE.match(line.strip())
        if m:
            events.append((int(m.group(2)), m.group(1), float(m.group(3)), m.group(4)))
    if not events:
        print('没有 ESM 事件；确认 --import 生效（stderr 应有 [boot-timing-esm] register ok）')
        return 1
    events.sort()

    loads = [e for e in events if e[1] == 'load']
    resolves = [e for e in events if e[1] == 'resolve']
    span = events[-1][0] - events[0][0]
    print('ESM 事件 %d 条（load %d / resolve %d），跨度 %d ms' % (
        len(events), len(loads), len(resolves), span))
    print('  load 合计 %.1f ms，resolve 合计 %.1f ms' % (
        sum(e[2] for e in loads), sum(e[2] for e in resolves)))

    print('\n最慢的 10 个 load：')
    for e in sorted(loads, key=lambda x: -x[2])[:10]:
        print('  %8.2f ms  %s' % (e[2], e[3]))

    gaps = []
    for i in range(len(events) - 1):
        gaps.append((events[i + 1][0] - events[i][0], events[i][3], events[i + 1][1]))
    gaps.sort(reverse=True)
    print('\n相邻间隙合计 %d ms（间隙 = 上一个模块的求值/初始化）：' % sum(g[0] for g in gaps))
    for g in gaps[:top]:
        print('  %6d ms  ← %s' % (g[0], g[1]))

    by_pkg = defaultdict(float)
    for e in loads:
        by_pkg[package_of(e[3])] += e[2]
    print('\n按 package 的 load 耗时 TOP 10：')
    for name, ms in sorted(by_pkg.items(), key=lambda x: -x[1])[:10]:
        print('  %9.1f ms  %s' % (ms, name))
    return 0


def shorten(url, keep=3):
    if not url:
        return '(native)'
    parts = url.split('/')
    return '/'.join(parts[-keep:]) if len(parts) > keep else url


def analyze_prof(path, top=25):
    data = json.load(open(path, encoding='utf-8'))
    nodes = {n['id']: n for n in data.get('nodes', [])}
    samples = data.get('samples', [])
    deltas = data.get('timeDeltas', [])
    if not samples:
        print('profile 没有 samples')
        return 1
    self_us = defaultdict(float)
    for i, sid in enumerate(samples):
        d = deltas[i] if i < len(deltas) else 0
        self_us[sid] += d

    rows = []
    for sid, us in self_us.items():
        n = nodes.get(sid)
        if not n:
            continue
        cf = n.get('callFrame', {})
        rows.append((us, cf.get('functionName') or '(anonymous)',
                     cf.get('url') or '', cf.get('lineNumber')))
    rows.sort(reverse=True)
    total_us = sum(self_us.values()) or 1
    print('采样 %d 条，覆盖 %.0f ms，进程内 CPU 时间 %.0f ms' % (
        len(samples), sum(deltas) / 1000.0, total_us / 1000.0))
    print('\nself time TOP %d：' % top)
    for us, fn, url, line in rows[:top]:
        print('  %8.1f ms  %5.1f%%  %s  %s:%s' % (
            us / 1000.0, 100.0 * us / total_us, fn, shorten(url), line))

    by_pkg = defaultdict(float)
    for us, fn, url, line in rows:
        by_pkg[package_of(url)] += us
    print('\n按 package 的 self time TOP 12：')
    for name, us in sorted(by_pkg.items(), key=lambda x: -x[1])[:12]:
        print('  %9.1f ms  %5.1f%%  %s' % (us / 1000.0, 100.0 * us / total_us, name))
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    top = 15
    if '--top' in argv:
        i = argv.index('--top')
        try:
            top = int(argv[i + 1])
        except (IndexError, ValueError):
            pass
        argv = argv[:i] + argv[i + 2:]
    if '--esm' in argv:
        return analyze_esm(argv[argv.index('--esm') + 1], top)
    if '--prof' in argv:
        return analyze_prof(argv[argv.index('--prof') + 1], max(top, 25))
    print(__doc__.strip())
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))