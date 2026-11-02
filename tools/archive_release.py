#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一次发布的产物归档到工作区 release-archive/<appVersion>/。

用法：
    python3 tools/archive_release.py --build 1.1.0-154
    python3 tools/archive_release.py --build 1.1.0-155 --dry-run

归档内容：
    apk/        dsh-ci-<build>.apk  → dsh-android-<appVersion>[-<build>]-arm64.apk
    evidence/   verify-<build>*、dsh-<build>-ui.png、失败截图
    scripts/    install-/verify-<build>.sh、mp-verify.cjs
    SHA256SUMS.txt（增量缓存，只对新文件算 sha256）
    README.md（按 evidence 目录自动生成）
    archive.jsonl（每次归档追加一行）

设计约定：
- 只复制，不删除 Download 源文件；清理交给 tools/clean_download 之类单独动作。
- 同一 appVersion 下重复 build → 覆盖同名证据；APK 字节不同则自动加 `-<build>` 后缀，绝不静默覆盖旧包。
- 缺文件不报错退出：CI 只出了一半、或手工补证据时仍能归档已有部分。
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import sys
import time

WORKSPACE = "/storage/emulated/0/MT2/apks/deepseek harness/DSHAPP-main"
ARCHIVE = "/storage/emulated/0/MT2/apks/deepseek harness/release-archive"
DOWNLOAD = "/storage/emulated/0/Download"
REPO_URL = "https://github.com/kai6666666/deepseek-harness/releases/tag/v{}"


def app_version():
    txt = open(f"{WORKSPACE}/app/build.gradle.kts", encoding="utf-8").read()
    m = re.search(r'^\s*versionName\s*=\s*"([^"$]+)"', txt, re.M)
    return m.group(1) if m else "0.0.0"


def ui_version():
    txt = open(f"{WORKSPACE}/app/src/main/java/com/dsh/android/EngineManager.kt",
               encoding="utf-8").read()
    m = re.search(r'MOBILE_UI_VERSION\s*=\s*"([^"]+)"', txt)
    return m.group(1) if m else ""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def copy(src, dst, dry=False):
    if not os.path.isfile(src):
        return None
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.abspath(src) == os.path.abspath(dst):
        return dst
    if not dry:
        shutil.copy2(src, dst)
    return dst


def archive_apk(build, ver, rel, dry):
    src = f"{DOWNLOAD}/dsh-ci-{build}.apk"
    if not os.path.isfile(src):
        return None, "missing"
    name = f"dsh-android-{ver}-arm64.apk"
    dst = f"{rel}/apk/{name}"
    if os.path.isfile(dst) and sha256(src) != sha256(dst):
        name = f"dsh-android-{ver}-{build}-arm64.apk"
        dst = f"{rel}/apk/{name}"
    copy(src, dst, dry)
    return dst, "copied"


def files_for(rel, build):
    pats = [
        f"{DOWNLOAD}/verify-{build}*",
        f"{DOWNLOAD}/dsh-{build}-*.png",
        f"{DOWNLOAD}/install-{build}.sh",
        f"{DOWNLOAD}/verify-{build}.sh",
        f"{DOWNLOAD}/mp-verify.cjs",
    ]
    out = []
    for p in pats:
        out.extend(sorted(glob.glob(p)))
    seen, uniq = set(), []
    for p in out:
        if p not in seen and os.path.isfile(p):
            seen.add(p)
            uniq.append(p)
    return uniq


def dest_for(rel, build, src):
    base = os.path.basename(src)
    if base.endswith(".sh"):
        return f"{rel}/scripts/{base}"
    if base == "mp-verify.cjs":
        return f"{rel}/scripts/mp-verify-{build}.cjs"
    if base.startswith("verify-"):
        return f"{rel}/evidence/{build}/{base}"
    if base.startswith("dsh-") and base.endswith(".png"):
        return f"{rel}/evidence/{build}/{base}"
    return f"{rel}/misc/{base}"


def refresh_sums(rel, dry):
    cache_path = f"{rel}/.sha256.cache.json"
    cache = {}
    if os.path.isfile(cache_path):
        try:
            cache = json.load(open(cache_path))
        except Exception:
            cache = {}
    lines, new_cache, hashed = [], {}, 0
    for sub in ("apk", "evidence", "scripts", "misc"):
        base = os.path.join(rel, sub)
        if not os.path.isdir(base):
            continue
        for root, _dirs, names in os.walk(base):
            for n in sorted(names):
                p = os.path.join(root, n)
                if not os.path.isfile(p):
                    continue
                key = os.path.relpath(p, rel)
                st = os.stat(p)
                sig = f"{st.st_size}:{int(st.st_mtime)}"
                if cache.get(key) and cache[key].get("sig") == sig:
                    digest = cache[key]["sha"]
                else:
                    digest = sha256(p)
                    hashed += 1
                new_cache[key] = {"sig": sig, "sha": digest, "size": st.st_size}
                lines.append(f"{digest}  {key}")
    if not dry:
        with open(f"{rel}/SHA256SUMS.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        json.dump(new_cache, open(cache_path, "w"), ensure_ascii=False, indent=1)
    return len(lines), hashed


def write_readme(rel, ver):
    ev = f"{rel}/evidence"
    builds = sorted(os.listdir(ev)) if os.path.isdir(ev) else []
    apks = sorted(os.listdir(f"{rel}/apk")) if os.path.isdir(f"{rel}/apk") else []
    lines = [
        f"# {ver} 发布归档",
        "",
        f"自动生成：{time.strftime('%Y-%m-%d %H:%M')}｜"
        f"来源：Release <{REPO_URL.format(ver)}>",
        "",
        "## UI build",
        "",
        "| UI build | 证据目录 |",
        "|---|---|",
    ]
    for b in builds:
        lines.append(f"| {b} | `evidence/{b}/` |")
    lines += ["", "## APK", "", "| 文件 | 体积 | sha256 前 12 位 |", "|---|---|---|"]
    for a in apks:
        p = f"{rel}/apk/{a}"
        lines.append(f"| `{a}` | {os.path.getsize(p)/1048576:.1f} MB | `{sha256(p)[:12]}` |")
    lines += [
        "",
        "## 校验",
        "",
        "```bash",
        f"cd '{rel}' && sha256sum -c SHA256SUMS.txt",
        "```",
        "",
        "远端 Release 是发布事实源，本目录是本地副本与证据归档。",
        "",
    ]
    with open(f"{rel}/README.md", "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", default="", help="移动端 UI build，例如 1.1.0-154")
    ap.add_argument("--app-version", default="", help="默认读 app/build.gradle.kts")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    build = a.build or ui_version()
    ver = a.app_version or app_version()
    if not build:
        print("[archive] 无法确定 UI build，跳过")
        return 1

    rel = f"{ARCHIVE}/{ver}"
    if not a.dry_run:
        os.makedirs(f"{rel}/apk", exist_ok=True)
        os.makedirs(f"{rel}/evidence/{build}", exist_ok=True)
        os.makedirs(f"{rel}/scripts", exist_ok=True)

    apk, why = archive_apk(build, ver, rel, a.dry_run)
    copied, missing = [], []
    for src in files_for(rel, build):
        dst = dest_for(rel, build, src)
        copy(src, dst, a.dry_run)
        copied.append(dst)

    if not a.dry_run:
        write_readme(rel, ver)
        n, hashed = refresh_sums(rel, a.dry_run)
        rec = {
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "app": ver,
            "build": build,
            "apk": os.path.basename(apk) if apk else None,
            "apk_state": why,
            "files": len(copied),
            "sums": n,
            "hashed": hashed,
        }
        with open(f"{rel}/archive.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(f"[archive] {ver} / {build}  apk={os.path.basename(apk) if apk else '无'} "
          f"({why})  files={len(copied)}")
    for p in copied:
        print(f"[archive]   + {os.path.relpath(p, rel)}")
    if not a.dry_run:
        print(f"[archive] SHA256SUMS.txt {n} 项（本次新算 {hashed}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())