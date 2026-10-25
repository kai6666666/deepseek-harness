#!/usr/bin/env python3
"""finish-g13-g21.py —— 收掉最后两条半：G-13 的 virtualPrefix、G-21 的诊断包接入

三处改动：
  1) index.js：真正用上 provision.json 里的 `virtualPrefix`
     （apk 是 `--virtual <group>`，装成「一个可整组撤掉的虚拟包」，而不是散包）
  2) verify-rootfs.sh：BUNDLE_DIR 可指定输出目录（默认 $DSH_HOME/logs，
     传 filesDir/logs 就能被诊断包收走）
  3) DiagnosticBundle.kt：build() 单点收 `verify-rootfs-*.json`
     （该文件自己写着「调用点有三个，逐个加必然漏」，所以在这里加一次）

每处断言命中恰好 1 次。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
subs = []


def sub(path: Path, old: str, new: str, why: str) -> None:
    subs.append((path, old, new, why))


# ── 1) G-13：virtualPrefix ────────────────────────────────────────────
sub(
    ROOT / "plugin-src/dsh-android-toolchain/lib/index.js",
    '  const argv = expand(backend.install, { pkgs: [...pkgs] });',
    """  // G-13：provision.json 里给每个后端声明了 `virtualPrefix`
  //   （apk → "--virtual"，apt → null）。以前这个字段**只是配置、没人读**。
  //   现在真用上：装成「一个虚拟包组」，整组可以用 `apk del <group>` 一次撤掉，
  //   而不是逐个删包（删错一个就把别的工具带崩）。
  const virtualGroup = spec?.virtualPrefix ? `dsh-tc-${Date.now().toString(36)}` : null;
  const pkgsArg = virtualGroup
    ? [spec.virtualPrefix, virtualGroup, ...[...pkgs]].join(" ")
    : [...pkgs].join(" ");
  const argv = expand(backend.install, { pkgs: pkgsArg });
  if (virtualGroup) {
    console.log(`[dsh-android-toolchain] 虚拟包组: ${virtualGroup}（apk del ${virtualGroup} 可整组撤掉）`);
  }""",
    "G-13 virtualPrefix",
)

# ── 2) G-21：BUNDLE_DIR 可指定 ────────────────────────────────────────
sub(
    ROOT / "tools/alpine-runtime/verify-rootfs.sh",
    '  _dir="${DSH_HOME:-$HOME/.dsh}/logs"',
    '  # G-21：BUNDLE_DIR 可指向 filesDir/logs —— 那才是 DiagnosticBundle 会收的目录\n'
    '  _dir="${BUNDLE_DIR:-${DSH_HOME:-$HOME/.dsh}/logs}"',
    "G-21 BUNDLE_DIR",
)

# ── 3) G-21：诊断包单点收 verify JSON ────────────────────────────────
sub(
    ROOT / "app/src/main/java/com/dsh/android/log/DiagnosticBundle.kt",
    '                budget -= writeLogFile(zos, logDir, LogStore.APP_LOG, budget, entriesWritten, completeness)',
    """                budget -= writeLogFile(zos, logDir, LogStore.APP_LOG, budget, entriesWritten, completeness)
                // G-21：`verify-rootfs.sh BUNDLE=1` 落的体检 JSON。
                //   以前它只留在 `$DSH_HOME/logs/`，诊断包里一个字都看不到，
                //   于是「体检跑过了」这件事在事后排查时等于没发生。
                //   这里跟着 logDir 收 —— 与上面那几份日志同一个入口，调用点不用改。
                runCatching {
                    logDir.listFiles { f ->
                        f.isFile && f.name.startsWith("verify-rootfs-") && f.name.endsWith(".json")
                    }
                        ?.sortedByDescending { it.lastModified() }
                        ?.take(MAX_VERIFY_JSON)
                        ?.forEach { vf ->
                            budget -= writeLogFile(zos, logDir, vf.name, budget, entriesWritten, completeness)
                        }
                }""",
    "G-21 DiagnosticBundle",
)

# ── 3b) 常量 ──────────────────────────────────────────────────────────
sub(
    ROOT / "app/src/main/java/com/dsh/android/log/DiagnosticBundle.kt",
    "    private const val MAX_STARTUP_LOGS = 5",
    """    private const val MAX_STARTUP_LOGS = 5

    /** G-21：诊断包里最多收几份 rootfs 体检 JSON（只留最近的）。 */
    private const val MAX_VERIFY_JSON = 3""",
    "MAX_VERIFY_JSON",
)

fail = 0
changed = {}
for path, old, new, why in subs:
    src = changed.get(path) or path.read_text(encoding="utf-8")
    n = src.count(old)
    if n != 1:
        print(f"✗ {why}: 命中 {n} 次（应为 1）", file=sys.stderr)
        fail += 1
        continue
    changed[path] = src.replace(old, new, 1)
    print(f"✓ {why}")

if fail:
    print(f"\n{fail} 处失败，未写盘", file=sys.stderr)
    raise SystemExit(1)

for path, text in changed.items():
    path.write_text(text, encoding="utf-8")
    print(f"  → {path.relative_to(ROOT)}")