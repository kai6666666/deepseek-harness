#!/usr/bin/env python3
"""check-proot.py —— 校验 build-proot 的产物是不是「aarch64 静态」。

判定条件：
  · ELF64
  · e_machine == 0xb7 (AArch64)
  · 没有 PT_INTERP（静态；有 interp 就必须带上那个 loader，Android 上没法保证）

用法：python3 tools/check-proot.py <candidate...>
成功时把合格的那个复制成 ./proot-arm64-static 并以 0 退出。
"""
import glob
import os
import shutil
import struct
import sys


def describe(path):
    with open(path, "rb") as fh:
        d = fh.read()
    if d[:4] != b"\x7fELF":
        return None
    endian = "<" if d[5] == 1 else ">"
    e_type, e_machine = struct.unpack_from(endian + "HH", d, 16)
    interp = None
    if d[4] == 2:
        phoff = struct.unpack_from(endian + "Q", d, 32)[0]
        phentsize, phnum = struct.unpack_from(endian + "HH", d, 54)
        for i in range(phnum):
            off = phoff + i * phentsize
            if struct.unpack_from(endian + "I", d, off)[0] == 3:
                o = struct.unpack_from(endian + "Q", d, off + 8)[0]
                sz = struct.unpack_from(endian + "Q", d, off + 32)[0]
                interp = d[o:o + sz].split(b"\x00")[0].decode(errors="replace")
    return dict(size=len(d), machine=e_machine, type=e_type, interp=interp)


def main(argv):
    cands = [p for p in argv if os.path.isfile(p)]
    if not cands:
        cands = [p for p in glob.glob("proot/src/proot") + glob.glob("proot/src/*/proot")
                 if os.path.isfile(p)]
    print("candidates:", cands)
    good = None
    for p in cands:
        info = describe(p)
        if info is None:
            print(f"{p}: 不是 ELF")
            continue
        print(f"{p}: machine={hex(info['machine'])} type={info['type']} "
              f"interp={info['interp']} size={info['size']}")
        if info["machine"] == 0xB7 and info["interp"] is None:
            good = p
    if good is None:
        print("::error::没有产出 aarch64 静态 proot")
        return 1
    shutil.copy(good, "proot-arm64-static")
    os.chmod("proot-arm64-static", 0o755)
    print("OK ->", good)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
