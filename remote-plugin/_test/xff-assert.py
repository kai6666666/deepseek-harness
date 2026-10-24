#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""XFF 启动自检的两条分支验收（外部审计 P2-10）。

## 为什么必须实测

自检的价值全在「**探测值真的落进了那个桶**」这个判据上。它依赖三件事同时成立：
① `PAIR_PUBLIC_HEALTH` 指向的入口把我们的探测转给了本进程；
② 探测触发的失败计数**写在同一个进程**的 `_claim_failures` 里；
③ 判据读的是 `probe_ip in _claim_failures`。

任何一环错了，自检就会**永远打「通过」**——那是最糟的失效形态：它看起来在工作，
实际上什么都没验。所以这里把两条分支都跑出来：

- **无代理**（探测直接打 `127.0.0.1`）：`_client_ip` 会取到客户端自己写的 XFF
  ⇒ 伪造值**就是**桶键 ⇒ 自检必须报 **WARN 失败**。
- **有代理追加**（用一个会改写 XFF 的小转发器模拟 Cloudflare 的行为）：
  伪造值被覆盖 ⇒ 自检必须报 **通过**。

⚠️ 输出只用 ASCII（本机控制台 GBK）。

用法：

    cd remote-plugin\\pair-server
    & "<python>" ..\\_test\\xff-assert.py
"""

import json
import os
import shutil
import socketserver
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler

FAILED = []
PASSED = [0]


def check(label, condition, detail=""):
    if condition:
        PASSED[0] += 1
        print("  ok   %s" % label)
    else:
        FAILED.append(label)
        print("  FAIL %s %s" % (label, detail))


class AppendingProxy(BaseHTTPRequestHandler):
    """模拟「最后一跳追加真实来源 IP」的代理（Cloudflare 的行为）。

    ⚠️ 它**覆盖**成固定值而不是追加：这样断言才能确定地判断
    「桶键不再由客户端决定」。真实 CF 是把真 IP 追加在末尾，效果一样
    （`_client_ip` 取最后一位）。
    """

    protocol_version = "HTTP/1.1"

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        target = "http://127.0.0.1:%d%s" % (self.server.upstream_port, self.path)
        request = urllib.request.Request(target, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        # 关键：把客户端的 XFF 换成代理自己看到的来源。
        request.add_header("X-Forwarded-For", "198.51.100.77")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            # ⚠️ 上游回 400（我们预期的）**必须原样透传**，不能变成 502：
            # 自检区分「到达服务端」与「连不上」靠的就是状态码，
            # 一律转成 502 会让测试分不清代理到底转发成功没有。
            payload, status = error.read(), error.code
        except Exception:  # noqa: BLE001
            payload, status = b'{"error":"proxy-failed"}', 502
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # noqa: A003
        return


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def free_port():
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def boot(public_base, state):
    """起一个 pair_server 实例（同进程内 import，便于直接读限流字典）。

    ⚠️ 用 import 而不是 subprocess：自检的判据要读**同一个进程**里的
    `_claim_failures`。这也正是自检的设计前提。
    """
    for key in ("PAIR_RECORD_KEY",):
        os.environ.setdefault(key, "33" * 32)
    os.environ["PAIR_STATE_DIR"] = state
    os.environ["PAIR_HOST"] = "127.0.0.1"
    os.environ["PAIR_PORT"] = str(free_port())
    os.environ["PAIR_ADMIN_SECRET"] = "xff-test-admin"
    os.environ["PAIR_PUBLIC_HEALTH"] = public_base
    os.environ.pop("CF_API_TOKEN", None)
    here = os.path.dirname(os.path.abspath(__file__))
    server_dir = os.path.join(os.path.dirname(here), "pair-server")
    if server_dir not in sys.path:
        sys.path.insert(0, server_dir)
    import pair_server as srv

    # 换个端口重 import 不会重读环境变量，所以直接改模块级常量。
    srv.LISTEN_PORT = int(os.environ["PAIR_PORT"])
    srv.PAIR_PUBLIC_HEALTH = public_base
    from http.server import ThreadingHTTPServer

    server = ThreadingHTTPServer(("127.0.0.1", srv.LISTEN_PORT), srv.Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.3)
    return srv, server


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    if not os.path.isfile(os.path.join(os.path.dirname(here), "pair-server", "pair_server.py")):
        print("找不到 pair_server.py")
        return 1

    logs = []

    # ── 分支一：无代理（探测直打本机）⇒ 必须报失败 ─────────────────────
    print("[1] 无代理：伪造 XFF 会成为桶键 -> 自检必须 WARN 失败")
    state = tempfile.mkdtemp(prefix="pair-xff-")
    try:
        srv, server = boot("http://127.0.0.1:0", state)
        srv.PAIR_PUBLIC_HEALTH = "http://127.0.0.1:%d" % srv.LISTEN_PORT
        original_log = srv.log
        srv.log = lambda msg: (logs.append(str(msg)), original_log(msg))
        srv._claim_failures.clear()
        srv._assert_xff_trustworthy()
        srv.log = original_log
        joined = "\n".join(logs)
        check(
            "检测到分桶被架空（打 WARN）",
            "XFF 自检失败" in joined,
            joined[-200:],
        )
        check(
            "清理了探测造出来的桶",
            not any(k.startswith("203.0.113.") for k in srv._claim_failures),
            str(list(srv._claim_failures)[:3]),
        )
        server.shutdown()
        server.server_close()
    finally:
        shutil.rmtree(state, ignore_errors=True)

    # ── 分支二：有代理追加 ⇒ 必须报通过 ──────────────────────────────
    print("[2] 有代理追加真 IP：伪造 XFF 被覆盖 -> 自检必须报通过")
    logs2 = []
    state2 = tempfile.mkdtemp(prefix="pair-xff2-")
    proxy = None
    try:
        srv2, server2 = boot("http://127.0.0.1:0", state2)
        proxy_port = free_port()
        proxy = ProxyServer(("127.0.0.1", proxy_port), AppendingProxy)
        proxy.upstream_port = srv2.LISTEN_PORT
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        time.sleep(0.2)

        srv2.PAIR_PUBLIC_HEALTH = "http://127.0.0.1:%d" % proxy_port
        original_log2 = srv2.log
        srv2.log = lambda msg: (logs2.append(str(msg)), original_log2(msg))
        srv2._claim_failures.clear()
        srv2._assert_xff_trustworthy()
        srv2.log = original_log2
        joined2 = "\n".join(logs2)
        check("自检报通过", "XFF 自检通过" in joined2, joined2[-200:])
        check(
            "没有误报失败",
            "XFF 自检失败" not in joined2,
        )
        # 代理追加的那个 IP 才是真正的桶键 —— 这证明探测确实经代理走了一趟。
        check(
            "桶里是代理追加的真 IP",
            "198.51.100.77" in srv2._claim_failures,
            str(list(srv2._claim_failures)[:3]),
        )
    finally:
        if proxy is not None:
            proxy.shutdown()
            proxy.server_close()
        try:
            server2.shutdown()
            server2.server_close()
        except NameError:
            pass
        shutil.rmtree(state2, ignore_errors=True)

    print()
    print("PASSED=%d FAILED=%d" % (PASSED[0], len(FAILED)))
    for item in FAILED:
        print("  - %s" % item)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
