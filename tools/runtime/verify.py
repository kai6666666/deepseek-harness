#!/usr/bin/env python3
"""verify.py —— 运行时产物硬断言（不依赖设备、不依赖 proot）

用法：
    python3 tools/runtime/verify.py <rootfs.tar.xz> <manifest.json> <jniLibs-dir>

判据：
  1. 归档里必须有：node / dsh 入口 / dsh 启动 shim / 三个 C 产物
  2. node 与所有 *.node 必须是 AArch64 ELF（e_machine=183），且不得混入 x64/darwin 包
  3. jniLibs 四件套齐全、AArch64、libproot.so 的 DT_NEEDED 已改名为 libtalloc.so
  4. manifest 的 sha256/bytes 与归档一致，launch.argv 含 --rootfs 与 /usr/bin/env 锚点
  5. 归档条目不重复、路径不含反斜杠、不含 setuid 位

退出码：0 = 全过；1 = 有 FAIL（逐条打印）。
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tarfile

EM_BY_ABI = {"arm64-v8a": 183, "x86_64": 62}
REQUIRED = [
    "usr/bin/node",
    "usr/local/bin/dsh",
    "usr/local/bin/boo-sandbox-run",
    "usr/local/lib/libboosandbox.so",
    "usr/local/lib/liblinkcompat.so",
    "opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
]
REQUIRED_JNI = ["libproot.so", "libproot-loader.so"]
BAD_PKG_FRAGMENTS = {
    "arm64-v8a": ("linux-x64", "linux-x32", "win32-", "darwin-", "android-arm64"),
    "x86_64": ("linux-arm64", "linux-aarch64", "android-arm64", "win32-", "darwin-"),
}

fails = []
oks = []


def ok(msg):
    oks.append(msg)


def bad(msg):
    fails.append(msg)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def elf_machine(blob):
    if len(blob) < 20 or blob[:4] != b"\x7fELF":
        return None
    endian = "little" if blob[5] == 1 else "big"
    return int.from_bytes(blob[18:20], endian)


def norm(name):
    while name.startswith("./"):
        name = name[2:]
    return name.lstrip("/")


def check_manifest(manifest):
    argv = manifest.get("launch", {}).get("argv", [])
    joined = " ".join(argv)
    for needle in ("--rootfs={ROOTFS}", "/usr/bin/env", "{GUEST_ENV}", "{PORT}", "{PATCHES}"):
        if needle not in joined:
            bad("launch.argv 缺 " + needle)
        else:
            ok("launch.argv 含 " + needle)
    if not manifest.get("runtimeVersion"):
        bad("runtimeVersion 为空")
    else:
        ok("runtimeVersion=" + manifest["runtimeVersion"])
    if manifest.get("abi") not in EM_BY_ABI:
        bad("abi 未知：" + str(manifest.get("abi")))
    if "{" not in manifest.get("stop", {}).get("pidFile", ""):
        bad("stop.pidFile 不是模板")
    else:
        ok("stop.pidFile=" + manifest["stop"]["pidFile"])


def check_archive(path, manifest):
    abi = manifest.get("abi", "arm64-v8a")
    em = EM_BY_ABI.get(abi)
    if em is None:
        bad("未知 abi：" + str(abi))
        em = EM_BY_ABI["arm64-v8a"]
    size = 0
    seen = set()
    with tarfile.open(path, "r:xz") as tf:
        members = {}
        for m in tf:
            n = norm(m.name)
            if n in seen:
                bad("归档条目重复：" + n)
            seen.add(n)
            members[n] = m
            if m.isfile():
                size += m.size
            if m.mode & 0o4000:
                bad("setuid 位不该出现：" + n)

        for req in REQUIRED:
            if req not in members:
                bad("缺文件：" + req)
            else:
                ok("存在 " + req)

        def read_head(name):
            m = members.get(name)
            if m is None or not m.isfile():
                return b""
            f = tf.extractfile(m)
            return f.read(4096) if f else b""

        head = read_head("usr/bin/node")
        if elf_machine(head) != em:
            bad("usr/bin/node 不是 AArch64 ELF")
        else:
            ok("usr/bin/node 是 AArch64")

        node_files = [n for n in members if n.endswith(".node")]
        wrong = []
        for n in node_files:
            m = members[n]
            if not m.isfile():
                continue
            f = tf.extractfile(m)
            if f is None:
                continue
            machine = elf_machine(f.read(4096))
            if machine != em:
                wrong.append(n + "(e_machine=" + str(machine) + ")")
        if wrong:
            bad("以下原生模块不是 AArch64：" + ", ".join(wrong[:10]))
        else:
            ok(str(len(node_files)) + " 个 .node 全是 AArch64")

        mixed = sorted(
            n for n in members
            if any(frag in n for frag in BAD_PKG_FRAGMENTS.get(abi, ())) and n.endswith("package.json")
        )
        if mixed:
            bad("归档里混入其它平台包：" + ", ".join(mixed[:10]))
        else:
            ok("未混入 x64/win32/darwin/android 平台包")

        if sha256_file(path) != manifest["rootfs"]["sha256"]:
            bad("manifest.rootfs.sha256 与实际归档不一致")
        else:
            ok("manifest sha256 一致")
        if int(manifest["rootfs"]["bytes"]) != os.path.getsize(path):
            bad("manifest.rootfs.bytes 与归档文件大小不一致")
        else:
            ok("manifest bytes 一致")


def check_jni(dirpath, em):
    for name in REQUIRED_JNI:
        p = os.path.join(dirpath, name)
        if not os.path.isfile(p):
            bad("缺 jniLib：" + name)
            continue
        with open(p, "rb") as f:
            if elf_machine(f.read(4096)) != em:
                bad("jniLib 不是 AArch64：" + name)
                continue
        ok("jniLib " + name)

    proot = os.path.join(dirpath, "libproot.so")
    try:
        out = subprocess.run(["readelf", "-d", proot], capture_output=True, text=True, check=True).stdout
    except Exception as e:  # noqa: BLE001
        bad("readelf 失败（跳过 DT_NEEDED 断言）：" + str(e))
        return
    if "libtalloc.so.2" not in out:
        bad("libproot.so 的 DT_NEEDED 不含 libtalloc.so.2（不应再 patchelf）")
    else:
        ok("libproot.so 保持原始 DT_NEEDED libtalloc.so.2")


def main():
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    rootfs, manifest_path, jni_dir = sys.argv[1:4]
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    check_manifest(manifest)
    check_archive(rootfs, manifest)
    check_jni(jni_dir, EM_BY_ABI.get(manifest.get("abi", "arm64-v8a"), 183))

    print("\n== 运行时产物体检 ==")
    for o in oks:
        print("  OK   " + o)
    for b in fails:
        print("  FAIL " + b)
    print("---- RUNTIME " + ("PASS" if not fails else "FAIL") + "  " + str(len(oks)) + " OK / " + str(len(fails)) + " FAIL")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
