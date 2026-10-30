#!/usr/bin/env python3
"""CI 终验（Linux 侧）：读最近一次 android-release 的结论与产物，一行判定。

用法：python3 tools/verify-ci.py
"""
import json
import sys
import urllib.request
from pathlib import Path

API = 'https://api.github.com/repos/kai6666666/deepseek-harness'
TOKEN = Path('/tmp/gh_token')
HEAD = {'Accept': 'application/vnd.github+json', 'User-Agent': 'dsh-verify'}
if TOKEN.exists():
    HEAD['Authorization'] = 'Bearer ' + TOKEN.read_text().strip()


def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=HEAD), timeout=60))


def main():
    try:
        runs = get(API + '/actions/workflows/android-release.yml/runs?per_page=3')
    except Exception as e:
        print('---- CI UNKNOWN  (%s)' % type(e).__name__)
        return 2

    runs = runs.get('workflow_runs', [])
    if not runs:
        print('---- CI UNKNOWN  (no android-release run yet)')
        return 2

    r = runs[0]
    rid, concl, sha = r['id'], r['conclusion'], r['head_sha'][:8]
    try:
        arts = get(API + '/actions/runs/%d/artifacts' % rid).get('artifacts', [])
        sizes = ', '.join('%s=%.0fMB' % (a['name'], a['size_in_bytes'] / 1048576.0) for a in arts) or 'none'
    except Exception:
        sizes = '?'

    steps = ''
    try:
        jobs = get(API + '/actions/runs/%d/jobs' % rid).get('jobs', [])
        bad = [s['name'] for j in jobs for s in j.get('steps', []) if s.get('conclusion') == 'failure']
        steps = 'failed_steps=' + (','.join(bad) if bad else 'none')
        # 产物自证：出包后拆 APK 检查 bootstrap + 两段 polyfill 补丁是否在包里。
        # 这条闸门失败时 CI 本来就会红，这里只是把结论单列出来，方便一眼看到。
        proof = [st['conclusion'] for j in jobs for st in j.get('steps', [])
                 if '产物自证' in st.get('name', '')]
        steps += ' product_proof=' + (','.join(sorted(set(proof))) if proof else 'missing')
    except Exception:
        pass

    print('run=%d sha=%s status=%s artifacts=%s %s' % (rid, sha, concl, sizes, steps))
    print('url=%s' % r['html_url'])
    if concl == 'success':
        print('---- CI PASS  run=%d' % rid)
        return 0
    print('---- CI FAIL  run=%d conclusion=%s' % (rid, concl))
    return 1


if __name__ == '__main__':
    sys.exit(main())