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


# ── CI 回归门禁（§4.36）────────────────────────────────────────────
#
# 为什么需要：「冷启 14.5 s」这种结果如果没人守，下一次改构建脚本 / 改 profile /
# 换 node 版本时就会悄悄退化，只能等人再用手机量一次才发现。这里把真机测到的
# 基线写进 `tools/boot-baseline.json`，CI 拿**固化的日志样本**跑一遍断言：
#
#   ① known-good.log 必须通过（证明工具与基线自洽）
#   ② regressed.log 必须被判红（证明阈值真的会红，不是摆设）
#
# 阈值形式：`actual <= value * (1 + tolerance)`；某个指标在日志里缺失 → 记为 skip，
# 不判红（除非基线里写了 `"required": true`）。
METRIC_KEYS = [
    ('preload_to_first_ms', 'preload→首响应'),
    ('listen_to_listening_ms', 'listen→listening'),
    ('modules_count', '模块数'),
    ('modules_compile_ms', '模块编译'),
    ('total_host_to_first_ms', 'host→首响应'),
]
def metrics_of(block):
    """把一块日志折算成可比的指标；缺失的指标不出现在结果里。"""
    kv = block['kv']
    out = {}
    v = f(kv, 'preload.to.first.ms')
    if v is not None:
        out['preload_to_first_ms'] = v
    v = f(kv, 'modules.count')
    if v is not None:
        out['modules_count'] = v
    v = f(kv, 'modules.compile.ms')
    if v is not None:
        out['modules_compile_ms'] = v
    listen = kv.get('epoch.listen')
    listening = kv.get('epoch.listening')
    if listen and listening and listen.isdigit() and listening.isdigit():
        out['listen_to_listening_ms'] = int(listening) - int(listen)
    first = f(kv, 'epoch.first')
    host = f(kv, 'host.epoch')
    if first is not None and host is not None:
        out['total_host_to_first_ms'] = first - host
    return out
def check_baseline(actual, baseline):
    """返回 (passed, failures, skips)。每个 failure 是一句人能看懂的话。"""
    default_tol = float(baseline.get('tolerance', 0.25))
    metrics = baseline.get('metrics') or {}
    failures, skips, passed = [], [], []
    for key, label in METRIC_KEYS:
        spec = metrics.get(key)
        if spec is None:
            continue
        value = actual.get(key)
        if value is None:
            if spec.get('required'):
                failures.append('%s(%s) 日志里缺失，但基线要求必填' % (label, key))
            else:
                skips.append('%s(%s)' % (label, key))
            continue
        tol = float(spec.get('tolerance', default_tol))
        limit = spec['limit'] * (1.0 + tol) if 'limit' in spec else spec['value'] * (1.0 + tol)
        base_value = spec.get('limit', spec.get('value'))
        if value > limit:
            failures.append(
                '%s(%s)=%d > %.0f（基线 %s，容差 %+.0f%%）'
                % (label, key, value, limit, base_value, tol * 100))
        else:
            passed.append('%s=%d ≤ %.0f' % (label, value, limit))
    return (not failures), failures, skips
def summarize(passed, failures, skips, baseline):
    lines = ['基线：%s（%s）' % (baseline.get('name', '未命名'), baseline.get('captured', '?'))]
    for p in passed:
        lines.append('  ✅ ' + p)
    for s in skips:
        lines.append('  ⏭️ ' + s + '（日志里没有，跳过）')
    for x in failures:
        lines.append('  ❌ ' + x)
    return '\n'.join(lines)
def main(argv):
    # 参数解析：带值的 flag 只有两个（--baseline / --log），其余是开关。
    # ⚠️ 不能简单地“过滤掉 -- 开头的 token 再把剩下的当路径” —— 那样
    # `--baseline x.json --log y.log` 里的 x.json 会被误当成日志路径（踩过）。
    path = None
    baseline_path = None
    flags = set()
    i = 1
    while i < len(argv):
        a = argv[i]
        if a in ('--baseline', '--log'):
            if i + 1 >= len(argv):
                print('::error::%s 需要一个参数' % a)
                return 2
            if a == '--baseline':
                baseline_path = argv[i + 1]
            else:
                path = argv[i + 1]
            i += 2
            continue
        if a.startswith('--'):
            flags.add(a)
            i += 1
            continue
        if path is None:
            path = a
        i += 1
    if path is None:
        print(__doc__.strip())
        return 2
    if path == '-':
        text = sys.stdin.read()
    else:
        with open(path, encoding='utf-8', errors='replace') as fh:
            text = fh.read()
    blocks = parse_blocks(text)
    if not blocks:
        print('没有找到 boot-timing 块；确认 NODE_OPTIONS 是否被注入（engine.log 应出现 [boot-timing] armed）')
        return 1
    if '--json-metrics' in flags:
        print(json.dumps([metrics_of(b) for b in blocks], ensure_ascii=False, indent=2))
        return 0
    if '--assert' in flags:
        if not baseline_path:
            print('::error::--assert 需要 --baseline <json>')
            return 2
        with open(baseline_path, encoding='utf-8') as fh:
            baseline = json.load(fh)
        # 只看最后一次启动：历史块可能来自旧版本，拿它们比会误报。
        actual = metrics_of(blocks[-1])
        ok, failures, skips = check_baseline(actual, baseline)
        print(summarize(['（全部指标在阈值内）'] if ok else [], failures, skips, baseline))
        if not ok:
            for x in failures:
                print('::error title=启动回归::' + x)
            return 1
        print('OK：启动耗时未越过基线阈值（%s）' % baseline.get('name', '?'))
        return 0
    if '--json' in flags:
        print(json.dumps([b['kv'] for b in blocks], ensure_ascii=False, indent=2))
        return 0
    for n, b in enumerate(blocks, 1):
        print(render(b, n))
        print()
    print('说明：PRoot 装载跨了宿主→guest 两个时钟域，靠宿主 spawn 前写下的 host.epoch 对齐，'
          '误差在个位数毫秒级；若 host.epoch=na，说明 DSH_HOME 里的 boot-timing.host.json 没写成功。')
    return 0
if __name__ == '__main__':
    sys.exit(main(sys.argv))
