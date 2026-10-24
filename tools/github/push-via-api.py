#!/usr/bin/env python3
"""push-via-api.py —— 用 github.com 不通、但 api.github.com 通时推代码。

背景：本机到 `github.com:443` 经常超时（git push 直接 fatal），
但 `api.github.com` 一直是 200。于是改走 Git Data API：
blob → tree（基于父提交的 tree，逐文件覆盖）→ commit → 更新 ref。

用法：
    export GITHUB_TOKEN=ghp_xxx
    python3 tools/github/push-via-api.py \\
        --repo kai6666666/deepseek-harness --branch main \\
        --message "feat: ..." \\
        --worktree . \\
        --files app/src/main/java/com/dsh/android/runtime/AlpineRuntime.kt ...

    # 语义等价于 `git add <files> && git commit && git push`，
    # 但**只推你列的这些文件**，不会把本地其它改动带上去。
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"


def req(method: str, path: str, token: str, payload=None):
    url = API + path
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dsh-push-via-api",
    }
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            body = resp.read().decode() or "{}"
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:800]
        print(f"✗ {method} {path} → HTTP {e.code}\n{detail}", file=sys.stderr)
        sys.exit(11)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--message", required=True)
    ap.add_argument("--worktree", default=".")
    ap.add_argument("--files", nargs="+", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("✗ 需要 GITHUB_TOKEN", file=sys.stderr)
        return 12

    # 1) 当前 ref
    st, ref = req("GET", f"/repos/{a.repo}/git/ref/heads/{a.branch}", token)
    head = ref["object"]["sha"]
    st, commit = req("GET", f"/repos/{a.repo}/git/commits/{head}", token)
    base_tree = commit["tree"]["sha"]
    print(f"== 父提交 {head[:7]} tree={base_tree[:7]}")

    # 2) 逐个建 blob
    entries = []
    for rel in a.files:
        p = os.path.join(a.worktree, rel)
        if not os.path.isfile(p):
            print(f"✗ 文件不存在：{rel}", file=sys.stderr)
            return 13
        raw = open(p, "rb").read()
        st, blob = req(
            "POST", f"/repos/{a.repo}/git/blobs", token,
            {"content": base64.b64encode(raw).decode(), "encoding": "base64"},
        )
        mode = "100755" if os.access(p, os.X_OK) else "100644"
        entries.append({"path": rel, "mode": mode, "type": "blob", "sha": blob["sha"]})
        print(f"   blob {blob['sha'][:7]} {mode} {rel} ({len(raw)} B)")

    # 3) 基于父 tree 建新 tree（只覆盖这些路径）
    st, tree = req(
        "POST", f"/repos/{a.repo}/git/trees", token,
        {"base_tree": base_tree, "tree": entries},
    )
    print(f"== 新 tree {tree['sha'][:7]}")

    # 4) commit
    st, newc = req(
        "POST", f"/repos/{a.repo}/git/commits", token,
        {"message": a.message, "tree": tree["sha"], "parents": [head]},
    )
    print(f"== 新 commit {newc['sha'][:7]}")

    if a.dry_run:
        print("· dry-run：未更新 ref")
        return 0

    # 5) 更新 ref（默认不强制：父提交不匹配时 GitHub 会拒绝，这是保护）
    st, out = req(
        "PATCH", f"/repos/{a.repo}/git/refs/heads/{a.branch}", token,
        {"sha": newc["sha"], "force": False},
    )
    print(f"✓ {a.branch} -> {out['object']['sha'][:7]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())