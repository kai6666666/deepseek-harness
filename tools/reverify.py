#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同版本二次取证对比。

用法：
    python3 tools/reverify.py --make 1.1.0-147   # 生成设备侧 verify-<ver>.sh（仅重启 + 取证）
    python3 tools/reverify.py 1.1.0-147          # 对比 verify-<ver>.json 与 verify-<ver>.run2.json

退出码：0 两次一致｜1 存在差异（差异项逐条打印，并归档）
"""
import hashlib
import json
import os
import sys

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

DL = "/storage/emulated/0/Download"
ROOT = "/storage/emulated/0/MT2/apks/deepseek harness/DSHAPP-main"
FAIL = f"{ROOT}/docs/agents/failures"
APP = "com.dsh.android"
STABLE = ["ok", "version", "stages", "items", "clicked", "mode", "text", "match", "msgs"]


def p(ver, suffix):
    return f"{DL}/verify-{ver}{suffix}"


def sha(path):
    if not os.path.exists(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()[:16]


def make_script(ver):
    script = f"""#!/system/bin/sh
# 同版本二次取证（不装机，只重启 + 再取一次）
APP={APP}
V={ver}
am force-stop $APP
am start -n $APP/.MainActivity >/dev/null 2>&1
sleep 30
cp /sdcard/Download/mp-verify.cjs /data/local/tmp/mp-verify.cjs
chmod 644 /data/local/tmp/mp-verify.cjs
run-as $APP sh -c 'cat /data/local/tmp/mp-verify.cjs > files/mp-verify.cjs'
P=$(pidof $APP)
LOG=/sdcard/Download/verify-$V.run2.txt
: > "$LOG"
echo "pid=$P retry_cfg=2 attempt=1" | tee -a "$LOG"
O=$(run-as $APP env MP_RETRY=2 MP_ATTEMPT=1 files/termux/usr/bin/node files/mp-verify.cjs "$P" "files/verify-$V.json" "$V" 2>&1)
echo "verify[run2] (MP_RETRY=2): $O" | tee -a "$LOG"
run-as $APP cat "files/verify-$V.json" > /data/local/tmp/v2.json 2>/dev/null
cp /data/local/tmp/v2.json /sdcard/Download/verify-$V.run2.json 2>/dev/null
run-as $APP cat "files/verify-$V.json.sum" > /data/local/tmp/s2.txt 2>/dev/null
cp /data/local/tmp/s2.txt /sdcard/Download/verify-$V.run2.sum 2>/dev/null
cat /sdcard/Download/verify-$V.run2.json >> "$LOG"
screencap -p /sdcard/Download/dsh-$V-run2.png
S=$(run-as $APP cat files/home/.dsh/mobile-ui/dsh-android-mobile/.mobile_ui_version)
echo "stamp=$S" | tee -a "$LOG"
echo
"""
    out = p(ver, ".sh")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(script)
    print(f"[reverify] 已生成 {out}（{len(script)} B）")
    print(f"[reverify] 设备侧执行： sh {out}")
    return 0


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def archive(ver, doc):
    os.makedirs(FAIL, exist_ok=True)
    import time
    name = f"reverify-{ver}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    with open(f"{FAIL}/{name}", "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    return name


def main():
    args = [a for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        return 2
    if args[0] == "--make":
        return make_script(args[1])
    ver = args[0]
    a, b = p(ver, ".json"), p(ver, ".run2.json")
    for x in (a, b):
        if not os.path.exists(x):
            raise SystemExit(f"[reverify] 缺少 {x}")
    d1, d2 = load(a), load(b)

    rows, diffs = [], []
    for k in STABLE:
        v1, v2 = d1.get(k), d2.get(k)
        same = v1 == v2
        if not same:
            diffs.append(k)
        rows.append((k, v1, v2, same))

    shot1, shot2 = sha(f"{DL}/dsh-{ver}-ui.png"), sha(f"{DL}/dsh-{ver}-run2.png")
    ms1, ms2 = d1.get("ms"), d2.get("ms")
    rt1, rt2 = d1.get("retries"), d2.get("retries")

    print(f"[reverify] {ver} · 首轮 vs 次轮")
    print(f"{'字段':<8} {'首轮':<46} {'次轮':<46} 一致")
    for k, v1, v2, same in rows:
        s1 = json.dumps(v1, ensure_ascii=False)
        s2 = json.dumps(v2, ensure_ascii=False)
        print(f"{k:<8} {s1[:44]:<46} {s2[:44]:<46} {'✅' if same else '❌'}")
    print(f"{'ms':<8} {str(ms1):<46} {str(ms2):<46} Δ={(ms2 - ms1) if isinstance(ms1, int) and isinstance(ms2, int) else '—'}")
    print(f"{'retries':<8} {json.dumps(rt1):<46} {json.dumps(rt2):<46}")
    print(f"{'shot':<8} {shot1 or '—':<46} {shot2 or '—':<46} {'同图' if shot1 == shot2 else '不同帧'}")

    verdict = "pass" if (d1.get("ok") and d2.get("ok") and not diffs) else "fail"
    doc = {
        "version": ver,
        "verdict": verdict,
        "diffs": diffs,
        "run1": {k: d1.get(k) for k in STABLE} | {"ms": ms1, "retries": rt1, "shot": shot1},
        "run2": {k: d2.get(k) for k in STABLE} | {"ms": ms2, "retries": rt2, "shot": shot2},
        "ms_delta": (ms2 - ms1) if isinstance(ms1, int) and isinstance(ms2, int) else None,
    }
    out = p(ver, ".reverify.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    print()
    if verdict == "pass":
        print(f"[reverify] 结论：两次取证一致（差异 0 项）→ {out}")
        return 0
    name = archive(ver, doc)
    print(f"[reverify] 结论：存在差异 {len(diffs)} 项 {diffs}，已归档 failures/{name}")
    return 1


if __name__ == "__main__":
    sys.exit(main())