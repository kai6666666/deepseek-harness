#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一条命令出正式包：推 client.js + 抬 MOBILE_UI_VERSION → 触发 CI → 等构建 → 下载 system APK。

用法：
    python3 tools/release.py 1.1.0-143
产物：
    /tmp/dsh-ci-<ver>/app-system-release.apk
    /storage/emulated/0/Download/dsh-ci-<ver>.apk
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

REPO = "kai6666666/deepseek-harness"
API = f"https://api.github.com/repos/{REPO}"
WORKSPACE = "/storage/emulated/0/MT2/apks/deepseek harness/DSHAPP-main"
CLIENT = f"{WORKSPACE}/mobile-ui-plugin/dsh-android-mobile/lib/client.js"
ENGINE = f"{WORKSPACE}/app/src/main/java/com/dsh/android/EngineManager.kt"
TOKEN_FILE = "/tmp/gh_token"
DOWNLOAD_DIR = "/storage/emulated/0/Download"


def token():
    with open(TOKEN_FILE) as f:
        return f.read().strip()


def req(method, path, body=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Authorization", f"Bearer {token()}")
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("User-Agent", "dsh-release")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else None


def get_file(path):
    d = req("GET", f"/contents/{path}?ref=main")
    return d["sha"], base64.b64decode(d["content"])


def put_file(path, blob, sha, message):
    d = req("PUT", f"/contents/{path}", {
        "message": message,
        "content": base64.b64encode(blob).decode(),
        "sha": sha,
        "branch": "main",
    })
    return d["content"]["sha"]


def push(version):
    newc = open(CLIENT, "rb").read()
    sha, oldc = get_file("mobile-ui-plugin/dsh-android-mobile/lib/client.js")
    if oldc != newc:
        put_file("mobile-ui-plugin/dsh-android-mobile/lib/client.js", newc, sha,
                 "mobile-ui: 更新 client.js")
        print(f"[push] client.js {len(oldc)} -> {len(newc)} B")
    else:
        print("[push] client.js 无变化")

    sha, old = get_file("app/src/main/java/com/dsh/android/EngineManager.kt")
    txt = old.decode("utf-8")
    m = re.search(r'const val MOBILE_UI_VERSION = "([^"]+)"', txt)
    cur = m.group(1) if m else "?"
    new = re.sub(r'(const val MOBILE_UI_VERSION = ")[^"]+(")',
                 r"\g<1>" + version + r"\g<2>", txt, count=1)
    if new != txt:
        put_file("app/src/main/java/com/dsh/android/EngineManager.kt", new.encode("utf-8"), sha,
                 f"chore: MOBILE_UI_VERSION -> {version}")
        print(f"[push] MOBILE_UI_VERSION {cur} -> {version}")
    else:
        print(f"[push] MOBILE_UI_VERSION 已是 {version}")


def dispatch(version):
    started = int(time.time())
    req("POST", "/actions/workflows/android-release.yml/dispatches",
        {"ref": "main", "inputs": {"reason": f"mobile-ui {version}"}})
    print("[ci] dispatch ok")
    return started


def wait_run(started, timeout_min=45):
    deadline = time.time() + timeout_min * 60
    run_id = None
    while time.time() < deadline:
        runs = req("GET", "/actions/runs?per_page=5")["workflow_runs"]
        cand = [r for r in runs if r["name"] == "android-release" and r["created_at"] >= time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started - 30))]
        if cand:
            run_id = cand[0]["id"]
            break
        time.sleep(10)
    if not run_id:
        raise SystemExit("[ci] 没找到刚触发的 run")
    print(f"[ci] run {run_id}")
    while time.time() < deadline:
        jobs = req("GET", f"/actions/runs/{run_id}/jobs")["jobs"]
        state = [(j["name"], j["status"], j["conclusion"]) for j in jobs]
        print("[ci]", state)
        if all(j["status"] == "completed" for j in jobs):
            if all(j["conclusion"] == "success" for j in jobs):
                return run_id
            raise SystemExit("[ci] 构建失败")
        time.sleep(20)
    raise SystemExit("[ci] 超时")


def download(run_id, version):
    sysart = None
    for _ in range(30):
        arts = req("GET", f"/actions/runs/{run_id}/artifacts")["artifacts"]
        sysart = next((a for a in arts if a["name"] == "dsh-system-release"), None)
        if sysart:
            break
        time.sleep(5)
    if not sysart:
        raise SystemExit("[dl] 没有 system artifact")
    out = f"/tmp/dsh-ci-{version}"
    os.makedirs(out, exist_ok=True)
    zpath = os.path.join(out, "sys.zip")
    # 用 curl 下：artifact 会 302 到 Azure Blob，urllib 会把 Authorization 一起带过去导致 401
    subprocess.run(["curl", "-sL", "--retry", "5", "--retry-all-errors",
                    "-H", f"Authorization: Bearer {token()}",
                    "-o", zpath, f"{API}/actions/artifacts/{sysart['id']}/zip"], check=True)
    with zipfile.ZipFile(zpath) as z:
        z.extractall(out)
    apk = next(os.path.join(out, n) for n in os.listdir(out) if n.endswith(".apk"))
    print(f"[dl] {apk} {os.path.getsize(apk)} B")

    with zipfile.ZipFile(apk) as z:
        dex = z.read("classes7.dex")
        hit = dex.count(version.encode())
        ui = z.read("assets/mobile-ui.zip")
        open(os.path.join(out, "ui.zip"), "wb").write(ui)
    with zipfile.ZipFile(os.path.join(out, "ui.zip")) as z:
        clen = z.getinfo("lib/client.js").file_size
    print(f"[chk] dex 版本戳 {version} 命中 {hit} 次；APK 内 client {clen} B（源码 {os.path.getsize(CLIENT)} B）")
    if hit != 2 or clen != os.path.getsize(CLIENT):
        raise SystemExit("[chk] 产物校验失败")

    dst = os.path.join(DOWNLOAD_DIR, f"dsh-ci-{version}.apk")
    shutil.copyfile(apk, dst)
    print(f"[ok] {dst}")
    write_install_script(version)
    install_step(version, dst)


def write_install_script(version):
    """写一份可在 Android 侧直接跑的装机脚本（任何终端 App 里 sh 一下即可）。"""
    body = f"""#!/system/bin/sh
# 装机 + 重启 + 读版本戳（Android 侧执行：sh /sdcard/Download/install-{version}.sh）
set -e
cp /sdcard/Download/dsh-ci-{version}.apk /data/local/tmp/d.apk
pm install -r /data/local/tmp/d.apk
am force-stop com.dsh.android
am start -n com.dsh.android/.MainActivity >/dev/null 2>&1
sleep 25
run-as com.dsh.android cat files/home/.dsh/mobile-ui/dsh-android-mobile/.mobile_ui_version
echo
"""
    path = f"{DOWNLOAD_DIR}/install-{version}.sh"
    with open(path, "w") as f:
        f.write(body)
    os.chmod(path, 0o755)
    print(f"[ok] 装机脚本 {path}")


def adb_has_device():
    try:
        out = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return False
    return any(line.strip().endswith("	device") for line in out.splitlines()[1:] if line.strip())


def install_step(version, apk):
    """有 adb 设备就自动装，没有就把 Android 侧一条命令打出来。"""
    if adb_has_device():
        print("[install] 检测到 adb 设备，自动装机")
        subprocess.run(["adb", "install", "-r", apk], check=True)
        subprocess.run(["adb", "shell", "am", "force-stop", "com.dsh.android"])
        subprocess.run(["adb", "shell", "am", "start", "-n", "com.dsh.android/.MainActivity"])
        time.sleep(25)
        out = subprocess.run(["adb", "shell", "run-as", "com.dsh.android", "cat",
                              "files/home/.dsh/mobile-ui/dsh-android-mobile/.mobile_ui_version"],
                             capture_output=True, text=True).stdout.strip()
        print(f"[install] 设备版本戳 {out!r}（期望 {version}）")
        return out == version
    print("[install] 没有可用的 adb 设备（本机 adb 未连）——已生成 Android 侧脚本：")
    print(f"          sh /sdcard/Download/install-{version}.sh")
    return None


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 tools/release.py 1.1.0-143")
    version = sys.argv[1]
    if not re.match(r"^\d+\.\d+\.\d+-\d+$", version):
        raise SystemExit("版本号要形如 1.1.0-143")
    push(version)
    started = dispatch(version)
    run_id = wait_run(started)
    download(run_id, version)


if __name__ == "__main__":
    main()
