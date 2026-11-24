#!/usr/bin/env python3
"""CHANGELOG 自动生成（P2）

## 为什么需要它

`tools/version.sh --check` 要求 **CHANGELOG 最新正式版小节标题 == versionName**，
且小节里有 `vc=<n>` 且等于 versionCode。这条门禁很有效（拦过好几次发版），
但每次发版都要**手工把这一节的标题、日期、vc 写对**——debug.32 就因为忘了写小节
直接卡在 `step 16 版本戳`。

这个脚本只做一件事：把「提交历史」翻成一段可以直接粘进 CHANGELOG 的草稿，
标题/日期/vc 都按 `tools/app-version.txt` 的值填好，人只需要**删掉不需要的条目**。

## 用法

    # 1) 从最近一次 tag 到现在（有 .git 时，CI 里也能用）
    python3 tools/changelog.py --since v0.2.2-rc.5-debug.35

    # 2) 没有 .git（比如工作区只同步了部分文件）时走 GitHub API
    GITHUB_TOKEN=ghp_xxx python3 tools/changelog.py --from-api --since v0.2.2-rc.5-debug.35

    # 3) 直接写进 CHANGELOG（插在第一个 `## [` 之前）
    python3 tools/changelog.py --since v0.2.2-rc.5-debug.35 --write

## 分类规则

按 Conventional Commits 的 `type(scope): subject` 分到中文小节：

    feat      → ### 新增
    fix       → ### 修复
    perf      → ### 性能
    refactor  → ### 重构
    ci        → ### 工程（CI / 构建）
    docs      → ### 文档
    test      → ### 测试
    chore     → ### 杂项
    其它      → ### 其它

`BREAKING CHANGE` 或 `type!:` 的条目会被提到最前面并标 ⚠️。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------- 分类表

SECTIONS = [
    ("feat", "### 新增"),
    ("fix", "### 修复"),
    ("perf", "### 性能"),
    ("refactor", "### 重构"),
    ("ci", "### 工程（CI / 构建）"),
    ("test", "### 测试"),
    ("docs", "### 文档"),
    ("chore", "### 杂项"),
]
OTHER = "### 其它"

# 不该进 CHANGELOG 的提交（纯发版/纯合并）
SKIP_SUBJECT = re.compile(r"^(chore\(release\)|Merge |Revert \"|v?\d+\.\d+\.\d+\s*$)")

CONVENTIONAL = re.compile(
    r"^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<subject>.+)$"
)


def read_app_version(root: Path) -> tuple[str, str]:
    """读 tools/app-version.txt，返回 (versionName, versionCode)。"""
    f = root / "tools" / "app-version.txt"
    if not f.is_file():
        sys.exit(f"changelog.py: 找不到 {f}（请在仓库根目录运行）")
    name = code = ""
    for line in f.read_text(encoding="utf-8").splitlines():
        if line.startswith("versionName="):
            name = line.split("=", 1)[1].strip()
        elif line.startswith("versionCode="):
            code = line.split("=", 1)[1].strip()
    if not name or not code:
        sys.exit("changelog.py: app-version.txt 里缺 versionName / versionCode")
    return name, code


def commits_from_git(root: Path, since: str | None) -> list[str]:
    """用 git log 取「since..HEAD」的提交标题（第一行）。"""
    rng = f"{since}..HEAD" if since else "-30"
    cmd = ["git", "-C", str(root), "log", "--no-merges", "--format=%s", rng]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except subprocess.CalledProcessError as e:
        sys.exit(f"changelog.py: git log 失败：{e.stderr.strip()}")
    return [l for l in out.splitlines() if l.strip()]


def _api_get(url: str, token: str):
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "dsh-changelog",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def resolve_since_to_iso(repo: str, since: str, token: str) -> str:
    """把 tag / 分支 / sha 解成 ISO 时间。

    为什么不能直接过滤：`commits?since=` 只接受 ISO 时间，而用户自然想写
    `--since v0.2.2-rc.5-debug.35`。tag 也不是提交标题，没法在 subject 里匹配
    （第一版就是这么写的，结果退化成「最近 100 条」）。
    """
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", since):
        return since
    data = _api_get(
        f"https://api.github.com/repos/{repo}/commits?sha={since}&per_page=1", token
    )
    if not isinstance(data, list) or not data:
        sys.exit(f"changelog.py: 解析不出 `{since}` 对应的时间（tag/sha 不存在？）")
    return data[0]["commit"]["committer"]["date"]


def commits_from_api(repo: str, since: str | None, token: str) -> list[str]:
    """没有 .git 时用 GitHub REST 取提交标题。since 可以是 tag / 分支 / sha / ISO 时间。"""
    api = f"https://api.github.com/repos/{repo}/commits?per_page=100"
    if since:
        iso = resolve_since_to_iso(repo, since, token)
        api += f"&since={iso}"
    data = _api_get(api, token)
    return [c["commit"]["message"].splitlines()[0] for c in data]


def classify(subjects: list[str]) -> tuple[list[str], dict[str, list[str]], list[str]]:
    """返回 (breaking, sections{title: [line]}, unparsed)。"""
    breaking: list[str] = []
    buckets: dict[str, list[str]] = {title: [] for _, title in SECTIONS}
    buckets[OTHER] = []
    for raw in subjects:
        if SKIP_SUBJECT.match(raw):
            continue
        m = CONVENTIONAL.match(raw)
        if not m:
            buckets[OTHER].append(f"- {raw}")
            continue
        ctype = m.group("type").lower()
        scope = m.group("scope")
        subject = m.group("subject").strip()
        line = f"- {subject}" + (f"（`{scope}`）" if scope else "")
        if m.group("bang"):
            breaking.append(line)
        title = next((t for k, t in SECTIONS if k == ctype), OTHER)
        buckets[title].append(line)
    return breaking, buckets, buckets[OTHER]


def render(version: str, code: str, date: str, breaking, buckets, note: str = "") -> str:
    """拼出一个小节。逐块「标题 + 条目 + 空行」，避免块与块粘连。"""
    lines = [f"## [{version}] — {date}", f"vc={code}", ""]

    def block(title: str, items: list[str]) -> None:
        lines.append(title)
        lines.extend(items)
        lines.append("")

    if breaking:
        block("### ⚠️ 不兼容变更", breaking)
    for _, title in SECTIONS:
        items = buckets.get(title) or []
        if items:
            block(title, items)
    other = buckets.get(OTHER) or []
    if other:
        block(OTHER, other)
    if not breaking and not any(buckets.values()):
        block("### 无行为变更", ["本版只有版本号推进。"])
    if note:
        lines.append(note)
        lines.append("")
    return "\n".join(lines)


def insert_into_changelog(root: Path, block: str) -> None:
    f = root / "CHANGELOG.md"
    text = f.read_text(encoding="utf-8")
    m = re.search(r"^## \[", text, re.M)
    if not m:
        sys.exit("changelog.py: CHANGELOG.md 里找不到 `## [` 小节")
    head, tail = text[: m.start()], text[m.start():]
    f.write_text(head + block + "\n" + tail, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="从提交历史生成 CHANGELOG 草稿")
    ap.add_argument("--since", help="起点：git 用 tag/sha；--from-api 用 tag 或 ISO 时间")
    ap.add_argument("--from-api", action="store_true", help="不用 .git，改走 GitHub API")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "kai6666666/deepseek-harness"))
    ap.add_argument("--date", help="小节日期，默认今天（YYYY-MM-DD）")
    ap.add_argument("--write", action="store_true", help="直接插入 CHANGELOG.md")
    ap.add_argument("--version", help="覆盖 versionName（默认读 tools/app-version.txt）")
    ap.add_argument("--code", help="覆盖 versionCode（默认读 tools/app-version.txt）")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    # 显式给了 --version/--code 就不要求仓库里有版本文件：
    # 这个脚本也要能在「只同步了部分文件」的工作区里跑（dev 侧实测就是这种情况）。
    if args.version and args.code:
        v_name, v_code = args.version, args.code
    else:
        v_name, v_code = read_app_version(root)
        v_name = args.version or v_name
        v_code = args.code or v_code
    date = args.date or __import__("datetime").date.today().isoformat()

    if args.from_api:
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if not token:
            sys.exit("changelog.py: --from-api 需要 GITHUB_TOKEN / GH_TOKEN")
        subjects = commits_from_api(args.repo, args.since, token)
        note = f"> 自动生成：GitHub API `{args.repo}`，起点 `{args.since or '最近 100 条'}`。"
    else:
        subjects = commits_from_git(root, args.since)
        note = f"> 自动生成：`git log {args.since or '-30'}..HEAD`。"

    breaking, buckets, _ = classify(subjects)
    block = render(v_name, v_code, date, breaking, buckets, note)

    if args.write:
        insert_into_changelog(root, block)
        print(f"已插入 CHANGELOG.md：{v_name} / vc={v_code}（{len(subjects)} 条提交）")
    else:
        sys.stdout.write(block)
        print(f"\n共 {len(subjects)} 条提交；加 --write 直接插入 CHANGELOG.md。", file=sys.stderr)


if __name__ == "__main__":
    main()