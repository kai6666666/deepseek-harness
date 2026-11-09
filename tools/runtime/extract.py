#!/usr/bin/env python3
"""在 proot(--link2symlink) 环境里安全解包 tar：硬链接一律展开成独立副本。

用法：extract.py <archive> <dest> [strip_components]

为什么不用 tar -x：proot 的 --link2symlink 会把 link() 改写成
<dir>/.l2s.<name>NNNN 的符号链接链，随后 tar 打包时就会 "Too many levels
of symbolic links"。这里用 tarfile 逐条解，遇到 LNKTYPE 直接复制目标文件。
"""
import os
import shutil
import sys
import tarfile


def main() -> int:
    archive, dest = sys.argv[1], sys.argv[2]
    strip = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    os.makedirs(dest, exist_ok=True)
    count = links = 0
    with tarfile.open(archive, "r:*") as tf:
        for m in tf:
            parts = [p for p in m.name.split("/") if p not in ("", ".")]
            if strip:
                if len(parts) <= strip:
                    continue
                parts = parts[strip:]
            rel = "/".join(parts)
            if not rel:
                continue
            path = os.path.join(dest, rel)
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)

            if m.isdir():
                os.makedirs(path, exist_ok=True)
                os.chmod(path, m.mode & 0o7777)
            elif m.issym():
                if os.path.lexists(path):
                    os.unlink(path)
                os.symlink(m.linkname, path)
            elif m.islnk():
                src = os.path.join(dest, m.linkname.lstrip("./"))
                if os.path.lexists(path):
                    os.unlink(path)
                shutil.copy2(src, path)          # 硬链接 → 独立副本
                links += 1
            elif m.isfile():
                if os.path.lexists(path):
                    os.unlink(path)
                with tf.extractfile(m) as src, open(path, "wb") as out:
                    shutil.copyfileobj(src, out)
                os.chmod(path, m.mode & 0o7777)
                count += 1
            else:
                continue
    print(f"[extract] {os.path.basename(archive)}: files={count} hardlinks->copies={links}")
    return 0


if __name__ == "__main__":
    sys.exit(main())