#!/usr/bin/env python3
"""B 阶段启动分段：把 guest 侧 boot-timing.log 渲染成四段瀑布图。

用法：
    python3 tools/boot-timing-report.py files/logs/boot-timing.log
    adb shell run-as com.dsh.android cat files/logs/boot-timing.log | python3 tools/boot-timing-report.py -

日志由 `BootTimingPreload` 注入的 guest 脚本写出（见
`app/src/main/java/com/dsh/android/runtime/BootTimingPreload.kt`），一次启动一个
`--- boot-timing v1 ... ---` / `--- end ---` 块。

四段口径：
    PRoot 装载 = node.start.epoch - host.epoch
    node 引导  = preload          - node.start
    模块解析   = entry.end        - preload
    首响应     = first            - entry.end
"""

import json
import sys


def parse_blocks(text):
    blocks, cur = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith('--- boot-timing v1'):
            cur = {'header': line, 'kv': {}}
            reason = ''
            for part in line.split():
                if part.startswith('reason='):
                    reason = part.split('=', 1)[1]
            cur['reason'] = reason
            continue
        if cur is None:
            continue
        if line == '--- end ---':
            blocks.append(cur)
            cur = None
            continue
        if '=' in line:
            k, v = line.split('=', 1)
            cur['kv'][k] = v
    return blocks


def f(kv, key):
    """取整数；缺字段/非数字 → None。"""
    v = kv.get(key)
    if v is None or v == 'na':
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def delta(a, b):
    return None if a is None or b is None else a - b


def render(block, index):
    kv = block['kv']
    pre = f(kv, 'epoch.preload')
    host = f(kv, 'host.epoch')
    node_start = f(kv, 'node.start.epoch')
    entry_end = f(kv, 'epoch.entry.end')
    first = f(kv, 'epoch.first')

    listen = kv.get('epoch.listen')
    listening = kv.get('epoch.listening')
    listen = int(listen) if listen and listen.isdigit() else None
    listening = int(listening) if listening and listening.isdigit() else None
    if listen is not None and listening is not None:
        stages = [
            ('PRoot 装载', delta(node_start, host)),
            ('node 引导', delta(pre, node_start)),
            ('preload→listen', delta(listen, pre)),
            ('listen→listening', delta(listening, listen)),
            ('listening→首响应', delta(first, listening)),
        ]
    else:
        stages = [
            ('PRoot 装载', delta(node_start, host)),
            ('node 引导', delta(pre, node_start)),
            ('模块解析', delta(entry_end, pre)),
            ('首响应', delta(first, entry_end)),
        ]
    known = [(n, v) for n, v in stages if v is not None]
    total = delta(first, host) if first is not None and host is not None else None
    longest = max([v for _, v in known], default=1) or 1

    out = []
    out.append('#%d pid=%s node=%s reason=%s' % (
        index, kv.get('pid', '?'), kv.get('node', '?'), block['reason']))
    for name, value in stages:
        if value is None:
            out.append('  %-10s %10s  %s' % (name, 'na', '(该次启动没走到这一段)'))
            continue
        cells = int(round(value * 40.0 / longest))
        out.append('  %-10s %8d ms  %s' % (name, value, '#' * max(cells, 1)))
    if total is not None:
        out.append('  %-10s %8d ms' % ('合计', total))

    mods = kv.get('modules.count', '?')
    avg = kv.get('modules.avg.ms', '?')
    cached = kv.get('modules.cached', '?')
    out.append('  模块数 %s 平均 %s ms 缓存条目 %s' % (mods, avg, cached))

    top = kv.get('modules.top', '')
    if top:
        slowest = top.split(' | ')[:5]
        out.append('  最慢模块：')
        for item in slowest:
            out.append('    - ' + item)

    def io_couple(tag_pre, tag_first):
        a = kv.get(tag_pre, '')
        b = kv.get(tag_first, '')
        def grab(s, key):
            for part in s.split():
                if part.startswith(key + ':'):
                    try:
                        return int(part.split(':', 1)[1])
                    except ValueError:
                        return None
            return None
        rchar = grab(a, 'rchar')
        rchar2 = grab(b, 'rchar')
        rb = grab(a, 'read_bytes')
        rb2 = grab(b, 'read_bytes')
        if None in (rchar, rchar2, rb, rb2):
            return None
        return (rchar2 - rchar, rb2 - rb)

    io = io_couple('io.preload', 'io.first')
    if io:
        rchar, rb = io
        ratio = (100.0 * rb / rchar) if rchar else 0.0
        out.append('  读放大 rchar=+%d B  read_bytes=+%d B  ⇒ 命中页缓存 ~%.1f%%'
                   % (rchar, rb, 100.0 - ratio))
    return '\n'.join(out)


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip())
        return 2
    path = argv[1]
    text = sys.stdin.read() if path == '-' else open(path, encoding='utf-8', errors='replace').read()
    blocks = parse_blocks(text)
    if not blocks:
        print('没有找到 boot-timing 块；确认 NODE_OPTIONS 是否被注入（engine.log 应出现 [boot-timing] armed）')
        return 1
    if '--json' in argv:
        print(json.dumps([b['kv'] for b in blocks], ensure_ascii=False, indent=2))
        return 0
    for i, b in enumerate(blocks, 1):
        print(render(b, i))
        print()
    print('说明：PRoot 装载跨了宿主→guest 两个时钟域，靠宿主 spawn 前写下的 host.epoch 对齐，'
          '误差在个位数毫秒级；若 host.epoch=na，说明 DSH_HOME 里的 boot-timing.host.json 没写成功。')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
