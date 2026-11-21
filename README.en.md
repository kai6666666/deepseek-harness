# DSH for Android

**Run a full AI coding agent on your Android phone.**

[中文](README.md) · [Docs](docs/agents/README.md) · [Contributing](CONTRIBUTING.md)

---

## What is this

DSH for Android brings the [DSH](https://github.com/deepseek-ai) (DeepSeek Harness)
desktop engine to your phone as-is: a single **PRoot + glibc runtime** (the rootfs ships
`/usr/bin/node`), Node runs the `@deepseek-ai/dsh` engine, and a WebView loads DSH own
web GUI.

**No Termux dependency** — since `0.3.0` this is a single-host PRoot build with zero
Termux at runtime.

**It does not draw its own chat UI.** The interface is the official frontend, with
mobile adaptation handled by a bundled plugin. What you get is not a stripped-down
"mobile edition" — it is **the same frontend as desktop**, small enough to fit in a pocket.

```
APK
APK
 ├─ jniLibs (4)             libproot.so / libproot-loader.so / libtalloc.so / libandroid-shmem.so
 ├─ rootfs (arm64-v8a)      ubuntu 24.04 + glibc: /usr/bin/node + engine at /opt/dsh
 ├─ Runtime assets          assets/runtime/{manifest.json, rootfs-arm64-v8a.tar.xz}
 ├─ Native layer (opt-in)   linkcompat / boosandbox (bash sandbox)
 └─ Bundled plugins         mobile adaptation / floating bubble / UI probe / logs …
```

## Features

- **Full agent capability** — `bash`, file read/write, `grep`/`glob`, and a terminal PTY
  all work. Not just a read-only chat box.
- **Single web engine (system)** — since `0.3.x` the main line ships the `system`
  flavour only (device WebView). The `gecko` variant (bundled GeckoView) was last
  shipped in `v0.4.2`.
- **Mobile UI adaptation** — official frontend plus a narrow-screen plugin, not a rewrite.
- **Floating bubble** — summon the agent anytime; custom appearance, frame animation,
  video layers.
- **UI probe tool** — lets the model see the screen and tap buttons, enabling end-to-end
  self-testing.
- **Rescue mode** — when a plugin breaks the app so it won't open, a four-tier
  degradation ladder plus in-app plugin removal.
- **Logging & diagnostics** — three-tier storage, crash-site snapshots, one-tap
  diagnostic export.

## Quick start

### Install

Download the latest release (**v0.2.2-rc.3**, system WebView, arm64-v8a):

| Package | applicationId | Download |
|---|---|---|
| `dsh-android-0.2.2-rc.3-arm64.apk` | `com.dsh.android` | [Download](https://github.com/kai6666666/deepseek-harness/releases/download/v0.2.2-rc.3/dsh-android-0.2.2-rc.3-arm64.apk) |

All versions: [Releases](https://github.com/kai6666666/deepseek-harness/releases).

The **gecko variant** (bundled GeckoView, for old/broken system WebView) was last shipped in `v0.4.2`:
`dsh-android-0.4.2-gecko-arm64.apk` (`com.dsh.webview`). Since `0.3.x` the main line ships system WebView only.

| Package | applicationId | For |
|---|---|---|
| `DSH<version>.apk` | `com.dsh.android` | Current main line (`0.3.x`+ ships this only) |
| `dsh-android-0.4.2-gecko-arm64.apk` | `com.dsh.android.webview` | Historical gecko variant (stopped at `v0.4.2`) |

The gecko variant has a **different applicationId** and can coexist with the system
build, each with its own data directory.

> ⚠️ **arm64-v8a only** (`minSdk 26` / `targetSdk 35`).
> The old 15-character package-name and targetSdk ≤ 28 constraints are **both lifted** — see [Lifted historical constraints](#lifted-historical-constraints).

### Build from source

```powershell
$env:JAVA_HOME = "<path to your JDK 17>"   # must be set explicitly

.\gradlew.bat :app:assembleSystemDebug --console=plain
# → app\build\outputs\apk\system\debug\app-system-debug.apk

.\gradlew.bat :app:assembleGeckoDebug --console=plain
# → app\build\outputs\apk\gecko\debug\app-gecko-debug.apk
```

**Toolchain**: JDK 17 · AGP 8.8.2 · Kotlin 2.0.21 · Gradle 8.13 · compileSdk 35 · minSdk 26

### ⚠️ Runtime assets are not in the repository

After the single-runtime refactor only two kinds of runtime asset are needed, and
**neither is committed**:

| Asset | Produced by | Notes |
|---|---|---|
| `assets/runtime/rootfs-arm64-v8a.tar.xz` + `manifest.json` | the CI `runtime` job (`tools/runtime/build-runtime.sh`) | ubuntu 24.04 + node + `/opt/dsh`, **~1.3 GB unpacked** |
| `jniLibs/arm64-v8a/*.so` (four) | same | `libproot.so` / `libproot-loader.so` / `libtalloc.so` / `libandroid-shmem.so` |

In CI the `runtime` job of `apk.yml` copies them into `app/src/main/{assets/runtime,jniLibs}`.
To build locally, run `bash tools/runtime/build-runtime.sh` once (needs binfmt / proot).

Recipes and verification: [docs/agents/regen-assets.md](docs/agents/regen-assets.md).
The old Termux-era assets (`engine.bin` / `node-runtime.bin` / `bootstrap-aarch64.zip` and friends) are **gone**.

## Lifted historical constraints (do not code against the old rules)

Both were real platform facts once. The `0.3.0` single-host PRoot refactor lifted
**all of them**. This section stays only so nobody re-introduces them from old docs.

| Old rule | Why it used to hold | Why it no longer does |
|---|---|---|
| ① package name must be exactly 15 chars | `TermuxBootstrap.patchElfInPlace()` did an **equal-length in-place overwrite** of ELF `.dynstr`; `/data/data/<pkg>/` had to be 27 bytes ⇒ N = 15 | **That function and `TermuxBootstrap` are deleted.** Executables ship as jniLibs and rootfs ELFs are `mmap`ed by the proot loader, so no ELF prefix is rewritten at runtime ⇒ `applicationId` is free |
| ② targetSdk must be ≤ 28 | Since API 29, `execve()` on files inside the app private dir is denied (W^X / SELinux `untrusted_app`) | The kernel `execve` surface is only `nativeLibraryDir/*.so` (API 29 `execute_no_trans` exemption). **`targetSdk = 35`** today, verified on device at 29 → 30 → 34 → 35 |

**The only hard constraint left is `arm64-v8a`** (the runtime rootfs is built for that ABI only).
Sideload-only still holds, but because we self-sign — not because of targetSdk.

## Architecture

```
MainActivity (WebView / GeckoView)
      │  loads http://127.0.0.1:<port>
      ▼
  DSH Web GUI  ←── official frontend + mobile adaptation plugin
      │
      ▼  HTTP
  DSH engine (Node)
      │
      ├─ tool: bash       → via the boo-sandbox-run sandbox
      ├─ tool: read/write → link translated by liblinkcompat.so
      ├─ tool: grep/glob  → static ripgrep
      └─ tool: ui/bubble  → native bridge (file mailbox)
      │
      ▼
  PRoot rootfs (filesDir/runtime/rootfs: glibc + /usr/bin/node + /opt/dsh)
```

### Why so many native layers

On Android, `process.platform` is `'android'`, not `'linux'`, while DSH's official
native addons and platform checks assume one of `linux`/`darwin`/`win32`. Anywhere the
official code only recognizes linux but is otherwise libc-agnostic needs an Android
counterpart.

Worse, there are **three capabilities Android actively withholds**, which can only be
worked around at the libc boundary via `LD_PRELOAD`:

| Layer | Solves | Docs |
|---|---|---|
| `liblinkcompat.so` | SELinux denies `link()` (`EACCES`/`EINVAL`) | [link-compat.md](docs/agents/link-compat.md) |
| `boo-sandbox-run` + `libboosandbox.so` | No bwrap/Landlock on Android, yet `bash` requires a sandbox | [sandbox.md](docs/agents/sandbox.md) |

## Project layout

```
app/src/main/java/com/dsh/android/     native host (Kotlin)
app/src/main/jni/                      native layer (C, LD_PRELOAD)
app/src/main/assets/                   runtime assets (⚠️ not in repo, filled by the runtime job)
app/src/system/ · app/src/gecko/       per-flavor sources for the two web engines (gecko no longer shipped)
mobile-ui-plugin/                      bundled plugin sources (TypeScript/JS)
remote-plugin/                         pairing server + end-to-end tests
tools/                                 build and verification scripts
docs/agents/                           developer docs (60 articles, look up as needed)
```

## Documentation

**Do not read `docs/agents/` top to bottom** — use the index keyed by
"what are you changing": [docs/agents/README.md](docs/agents/README.md)

| If you're changing | Read first |
|---|---|
| anything native or subprocess-related | [platform-android.md](docs/agents/platform-android.md) |
| `bash` tool reports "no sandbox backend" | [sandbox.md](docs/agents/sandbox.md) |
| `write` tool reports `EACCES/EINVAL: link` | [link-compat.md](docs/agents/link-compat.md) |
| any `.zip` / `.bin` asset | [asset-stamps.md](docs/agents/asset-stamps.md) |
| release builds / signing / publishing | [build-and-ship.md](docs/agents/build-and-ship.md) |
| a plugin broke the app so it won't open | [rescue-mode.md](docs/agents/rescue-mode.md) |

> The developer docs are written in Chinese; the code and this README are the
> English-language entry points.

## Known limitations

- **The sandbox does not isolate the PID namespace** — `--unshare-pid` needs
  CAP_SYS_ADMIN, which ordinary apps cannot get. File write boundaries are complete.
- **arm64-v8a only** — no arm32 or x86 builds.
- **Sideload only** — self-signed distribution (targetSdk 35; unrelated to store listing).
- **Large APK** — ~195 MB (rootfs + engine + node ship inside the package).
- **Slow first launch** — a ~1.3 GB rootfs is unpacked (~110 s on our test device);
  cold start afterwards is ~66 s to `engine.ready`.

Full list: [boundaries.md](docs/agents/boundaries.md).

## Contributing

Issues and PRs are welcome. Before you start, read [CONTRIBUTING.md](CONTRIBUTING.md) —
it records the two **former** "wrong but compiles, then explodes on a real device"
constraints (now lifted, see above), plus silent-failure traps such as "changing an
asset requires bumping its version stamp."

## Acknowledgements

This project stands on the shoulders of:

- [DSH / DeepSeek Harness](https://github.com/deepseek-ai) — engine and web frontend
- [Termux](https://github.com/termux) — **historical source** of the pre-`0.3.0` bootstrap / node / adb binaries (all removed)
- [Mozilla GeckoView](https://wiki.mozilla.org/Mobile/GeckoView) — bundled web engine (gecko variant stopped at `v0.4.2`)
- [ripgrep](https://github.com/BurntSushi/ripgrep) · [sharp](https://github.com/lovell/sharp)
  · [pnpm](https://github.com/pnpm/pnpm) · [Shizuku](https://github.com/RikkaApps/Shizuku)

## License

[MIT](LICENSE)
