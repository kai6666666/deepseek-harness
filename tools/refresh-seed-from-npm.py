#!/usr/bin/env python3
"""refresh-seed-from-npm.py —— 重生成 market-plugin/dsh-android-market/lib/seed.json

## 为什么要有这个脚本

`tools/market-collect.mjs` 用 Node 的 `fetch` 直连 registry，在本机/某些网络环境下
会 `fetch failed`（DNS 或代理层），于是种子就停在旧快照上（G-14：9 vs 10 条、
`@jiuling/dsh-mcp-manager` 版本也落后）。本脚本做**同一件事**，但走 curl + 纯
Python，任何能跑 curl 的环境都能刷新。

## 产出与 collect.mjs 完全同构

逐字段映射见 `to_entry()`；额外从每个包的 packument 里取 `dsh` / `engines`
（搜索接口不返回这两项）。

用法：
    python3 tools/refresh-seed-from-npm.py            # 写 seed.json
    python3 tools/refresh-seed-from-npm.py --stdout    # 只打印
    python3 tools/refresh-seed-from-npm.py --limit 50

退出码：0 成功；1 网络/解析失败；2 参数错。
"""
import json
import subprocess
import sys
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "market-plugin/dsh-android-market/lib/seed.json"
REGISTRY = "https://registry.npmjs.org"
KEYWORDS = ["dshapp-plugin", "dshapp-plugin-featured"]


def curl_json(url: str):
    out = subprocess.run(
        ["curl", "-sL", "--max-time", "45", "-H", "Accept: application/json", url],
        capture_output=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"curl 失败 {url}: {out.returncode}")
    try:
        return json.loads(out.stdout.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"JSON 解析失败 {url}: {e}") from e


def search(keyword: str, limit: int):
    url = f"{REGISTRY}/-/v1/search?text=keywords:{keyword}&size={limit}"
    d = curl_json(url)
    return d.get("objects") or []


def to_entry(pkg: dict, packument: dict) -> dict:
    name = pkg["name"]
    ver = pkg["version"]
    vinfo = (packument.get("versions") or {}).get(ver) or {}
    kws = pkg.get("keywords") or vinfo.get("keywords") or []
    dsh = vinfo.get("dsh") or {}
    author = pkg.get("author") or {}
    links = pkg.get("links") or {}
    return {
        "name": name,
        "version": ver,
        "description": pkg.get("description") or "",
        "keywords": kws,
        "license": vinfo.get("license") or pkg.get("license"),
        "author": author.get("name") if isinstance(author, dict) else (author or None),
        "publisher": (pkg.get("publisher") or {}).get("username"),
        "homepage": links.get("homepage"),
        "repository": links.get("repository"),
        "engines": vinfo.get("engines"),
        "dsh": {
            "bundle": dsh.get("bundle"),
            "client": dsh.get("client"),
            "manifestVersion": dsh.get("manifestVersion"),
            "dshReleases": dsh.get("dshReleases"),
        },
        "installable": True,
        "risks": [],
        "publishedAt": pkg.get("date"),
        "featured": "dshapp-plugin-featured" in kws,
    }


def main() -> int:
    limit = 50
    to_stdout = "--stdout" in sys.argv
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    seen = {}
    try:
        for kw in KEYWORDS:
            for obj in search(kw, limit):
                p = obj["package"]
                seen[p["name"]] = p
        print(f"搜索到 {len(seen)} 个包", file=sys.stderr)

        entries = []
        for name, pkg in sorted(seen.items()):
            try:
                packument = curl_json(f"{REGISTRY}/{name.replace('/', '%2f')}")
            except RuntimeError as e:  # 单个包失败不该拖垮整轮
                print(f"  ! {name} 取 packument 失败，跳过 dsh/engines：{e}", file=sys.stderr)
                packument = {}
            entries.append(to_entry(pkg, packument))
    except RuntimeError as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1

    featured = sum(1 for e in entries if e["featured"])
    seed = {
        "schemaVersion": 2,
        "generatedAt": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "registry": REGISTRY,
        "keywords": KEYWORDS,
        "truncated": len(entries) >= limit,
        "counts": {
            "featured": featured,
            "community": len(entries) - featured,
            "total": len(entries),
        },
        "plugins": entries,
    }
    text = json.dumps(seed, ensure_ascii=False, indent=2) + "\n"
    if to_stdout:
        print(text)
    else:
        SEED.write_text(text, encoding="utf-8")
        print(f"✓ 写入 {SEED}（{len(text)} B，{len(entries)} 个包）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())