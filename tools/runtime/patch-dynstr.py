#!/usr/bin/env python3
"""等长改写 ELF .dynstr 里的库名（把 libtalloc.so.2 变成 libtalloc.so）。

为什么不是 patchelf
-------------------
patchelf 会重排 DT_NEEDED / 改节表，实测把 Termux 的 proot 改坏（x86_64 LDPlayer
上 --version 直接 SIGSEGV）。这里只做**字节等长原地替换**：

    "libtalloc.so.2\\0"  (15 B)  ->  "libtalloc.so\\0\\0\\0"  (15 B)

偏移不变、文件大小不变、节表不动 ⇒ 动态链接器只是按新名字去 LD_LIBRARY_PATH 找。

为什么要改名
------------
Android 打包只从 jniLibs 抽取 **以 .so 结尾** 的文件（lib*.so）。deb 里的
libtalloc.so.2.5.0 不符合该模式，只能作为 assets 下发（过去放到
files/proot-libs + LD_LIBRARY_PATH）。改名成 libtalloc.so 后即可进 jniLibs，
nativeLibraryDir 成为唯一原生来源。

用法
----
    patch-dynstr.py <elf> <old-name> <new-name>

退出码：0 = 至少改到 1 处；2 = 参数错误 / 长度超标；3 = 没找到目标串。
"""
import sys
from pathlib import Path


def main(argv):
    if len(argv) != 4:
        print("usage: patch-dynstr.py <elf> <old> <new>", file=sys.stderr)
        return 2
    path, old_s, new_s = argv[1], argv[2], argv[3]
    old, new = old_s.encode(), new_s.encode()
    if len(new) > len(old):
        print(f"patch-dynstr: new name longer than old ({len(new)} > {len(old)})", file=sys.stderr)
        return 2

    p = Path(path)
    data = p.read_bytes()
    # dynstr 里的字符串以 NUL 结尾：把 "old\0" 整体替换成 "new\0...\0"（等长）
    needle = old + b"\0"
    repl = new + b"\0" * (len(old) - len(new) + 1)
    assert len(needle) == len(repl)

    hits = data.count(needle)
    if hits == 0:
        print(f"patch-dynstr: {path}: '{old_s}' not found", file=sys.stderr)
        return 3

    out = data.replace(needle, repl)
    assert len(out) == len(data), "size must not change"
    p.write_bytes(out)
    print(f"patch-dynstr: {path}: {old_s} -> {new_s} x{hits} (size unchanged {len(out)})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
