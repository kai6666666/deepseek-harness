#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""让 DSHAPP 的砂层在 **glibc（proot Ubuntu）** 下编译并补全拦截面。

改两处
------
1) `linkcompat.c`：原实现只在 `EACCES/EPERM` 时转译 `link`。
   proot 的 ptrace 层可能直接返回 `ENOSYS` → DSH 的独占原子发布冒泡失败
   （每轮回复报错）。→ 同时认 `ENOSYS` / `EOPNOTSUPP`。

2) `boosandbox.c`：原文件已覆盖 open/open64/openat/fopen/fopen64/creat/
   mkdir/mkdirat/rename*/truncate/symlink*/link*/chmod/access —— **但缺**：
     · `openat64`（带 dirfd 的 64 位变体）
     · `creat64`
     · `__open_2` / `__open64_2` / `__openat_2` / `__openat64_2`
       （Ubuntu 默认开 `_FORTIFY_SOURCE`，程序走的是这四个符号）
     · `freopen` / `freopen64`（C 库层重定向）
   这次只追加这 8 个，**不重复定义已存在的符号**。

   ⚠️ 历史教训：之前试过「整块重写 open64 并把 C 名换成 boo_open64 +
   `__asm__("open64")`」，结果是同一 TU 里 open64 被定义两次
   （原文件第 358 行 + 追加块），汇编器报 `symbol 'open64' is already defined`。
   正确做法是**只补缺失符号、用普通函数名**——与文件里既有风格一致，
   glibc 允许这样覆盖头文件里的 fortify inline 定义。

幂等：重复执行不叠加；且能识别并修掉历史坏状态。

用法：
    python3 tools/apply-glibc-patches.py
    python3 tools/apply-glibc-patches.py --check

编译（proot Ubuntu 内）：
    gcc -O2 -shared -fPIC -o libboosandbox.so boosandbox.c -ldl
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
JNI = REPO / "app/src/main/jni"

LINKCOMPAT = JNI / "linkcompat.c"
BOOSANDBOX = JNI / "boosandbox.c"

LINK_OLD = "if (errno != EACCES && errno != EPERM) return -1;"
LINK_NEW = (
    "if (errno != EACCES && errno != EPERM && errno != ENOSYS &&\n"
    "      errno != EOPNOTSUPP) return -1;"
)

ANCHOR = "/* == C-scheme glibc additions == */"

ADDITIONS = ANCHOR + r'''
/* ── C 方案（glibc）补充拦截面 ────────────────────────────────────────────
 * 下面 8 个符号原文件没有；Ubuntu 默认开 _FORTIFY_SOURCE，程序会走
 * __open*_2 这四个，不补就是一条写路径的缺口。
 * 与文件既有风格一致：普通函数名 + dlsym(RTLD_NEXT)。
 * glibc 允许这样覆盖 bits/fcntl2.h 里的 fortify inline（原文件的 open64
 * 已经证明这条路可行）；同一个符号**不要**重复定义。
 */

int openat64(int dirfd, const char *path, int flags, ...) {
  static int (*real)(int, const char *, int, ...) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "openat64");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  if (writeish(flags) && !allowed_at(dirfd, path)) return deny(path);
  return real(dirfd, path, flags, mode);
}

int creat64(const char *path, mode_t mode) {
  static int (*real)(const char *, mode_t) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "creat64");
  if (!allowed(path)) return deny(path);
  return real(path, mode);
}

int __open_2(const char *path, int flags) {
  static int (*real)(const char *, int) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "__open_2");
  if (writeish(flags) && !allowed(path)) return deny(path);
  return real ? real(path, flags) : -1;
}

int __open64_2(const char *path, int flags) {
  static int (*real)(const char *, int) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "__open64_2");
  if (writeish(flags) && !allowed(path)) return deny(path);
  return real ? real(path, flags) : -1;
}

int __openat_2(int dirfd, const char *path, int flags) {
  static int (*real)(int, const char *, int) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "__openat_2");
  if (writeish(flags) && !allowed_at(dirfd, path)) return deny(path);
  return real ? real(dirfd, path, flags) : -1;
}

int __openat64_2(int dirfd, const char *path, int flags) {
  static int (*real)(int, const char *, int) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "__openat64_2");
  if (writeish(flags) && !allowed_at(dirfd, path)) return deny(path);
  return real ? real(dirfd, path, flags) : -1;
}

FILE *freopen(const char *path, const char *mode, FILE *stream) {
  static FILE *(*real)(const char *, const char *, FILE *) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "freopen");
  if (mode && (strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+')) &&
      !allowed(path)) {
    deny(path);
    return NULL;
  }
  return real(path, mode, stream);
}

FILE *freopen64(const char *path, const char *mode, FILE *stream) {
  static FILE *(*real)(const char *, const char *, FILE *) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "freopen64");
  if (!real) return freopen(path, mode, stream);
  if (mode && (strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+')) &&
      !allowed(path)) {
    deny(path);
    return NULL;
  }
  return real(path, mode, stream);
}
'''


def strip_additions(src: str) -> str:
    """去掉历史上追加过的任何块（含被截断的坏状态）。"""
    at = src.find(ANCHOR)
    if at == -1:
        for legacy in (
            "/* == C-scheme glibc bridge == */",
            "/* ── C-scheme glibc extra coverage",
            "/* == C-scheme glibc extra coverage",
        ):
            at = src.find(legacy)
            if at != -1:
                break
    if at == -1:
        return src
    head = src[: src.rfind("\n", 0, at) + 1]
    trimmed = head.rstrip()
    for dangling in ("/* ──", "/*"):
        if trimmed.endswith(dangling):
            trimmed = trimmed[: -len(dangling)].rstrip()
            break
    return trimmed + "\n"


def patch_linkcompat(check_only: bool) -> str:
    src = LINKCOMPAT.read_text(encoding="utf-8")
    if "errno != ENOSYS" in src and "errno != EOPNOTSUPP" in src:
        return "already"
    n = src.count(LINK_OLD)
    if n != 2:
        raise SystemExit(f"linkcompat.c: 期望 2 处，实际 {n} 处；上游改动过，请人工核对。")
    if check_only:
        return "needs-patch"
    LINKCOMPAT.write_text(src.replace(LINK_OLD, LINK_NEW), encoding="utf-8")
    return "patched"


def patch_boosandbox(check_only: bool) -> str:
    src = BOOSANDBOX.read_text(encoding="utf-8")
    base = strip_additions(src)
    desired = base.rstrip() + "\n\n" + ADDITIONS
    if src == desired:
        return "already"
    if check_only:
        return "needs-patch"
    BOOSANDBOX.write_text(desired, encoding="utf-8")
    return "patched"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查状态，不写文件")
    args = ap.parse_args()

    for required in (LINKCOMPAT, BOOSANDBOX):
        if not required.is_file():
            print(f"缺少 {required}", file=sys.stderr)
            return 2

    link = patch_linkcompat(args.check)
    boo = patch_boosandbox(args.check)
    print(f"linkcompat.c : {link}")
    print(f"boosandbox.c : {boo}")

    if args.check and "needs-patch" in (link, boo):
        print("\n需要打补丁：python3 tools/apply-glibc-patches.py")
        return 1
    print("\n编译：gcc -O2 -shared -fPIC -o libboosandbox.so boosandbox.c -ldl")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())