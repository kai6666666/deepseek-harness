<#
.SYNOPSIS
    从 agnes-keys.properties 生成 keyinject-keys.h，并编译出 assets/keyinject.bin。

.DESCRIPTION
    这是「内置号池」的构建入口。密钥清单**不入库**（.gitignore 已覆盖），
    生成的头文件也不入库，入库的只有：
      · app/src/main/jni/keyinject.c   —— 注入逻辑（手写源码）
      · tools/build-keyinject.ps1      —— 本脚本

    流程：
      keys.properties  ──XOR 混淆──▶  keyinject-keys.h  ──NDK 编译──▶  keyinject.bin

    产物 keyinject.bin 由 EngineManager 解到 filesDir 并经 LD_PRELOAD 注入引擎，
    它在 SSL_write 里把占位符换成真密钥。设计与取舍见 keyinject.c 头部注释。

.PARAMETER KeysFile
    密钥清单，默认仓库根的 agnes-keys.properties。

.PARAMETER SkipBuild
    只生成头文件，不编译（用于检查生成结果）。

.EXAMPLE
    .\tools\build-keyinject.ps1
#>
[CmdletBinding()]
param(
    [string]$KeysFile,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $KeysFile) { $KeysFile = Join-Path $repoRoot 'agnes-keys.properties' }

$jniDir = Join-Path $repoRoot 'app/src/main/jni'
$headerPath = Join-Path $jniDir 'keyinject-keys.h'
$sourcePath = Join-Path $jniDir 'keyinject.c'
$assetPath = Join-Path $repoRoot 'app/src/main/assets/keyinject.bin'

$ndkClang = "$env:LOCALAPPDATA\Android\Sdk\ndk\27.0.12077973\toolchains\llvm\prebuilt\windows-x86_64\bin\aarch64-linux-android26-clang.cmd"

# ── 1. 读密钥清单 ────────────────────────────────────────────────────────

if (-not (Test-Path $KeysFile)) {
    throw "找不到密钥清单: $KeysFile`n请从密钥文档创建它（格式见该文件头的注释），它不入库。"
}

$cnKeys = [System.Collections.Generic.List[string]]::new()
$intlKeys = [System.Collections.Generic.List[string]]::new()

foreach ($raw in Get-Content -LiteralPath $KeysFile -Encoding UTF8) {
    $line = $raw.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { throw "清单格式错误（应为 `名字=密钥`）: $line" }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1).Trim()

    if ($name -like 'cn.*') { $cnKeys.Add($value) }
    elseif ($name -like 'intl.*') { $intlKeys.Add($value) }
    else { throw "未知的名字前缀（应为 cn.* 或 intl.*）: $name" }
}

if ($cnKeys.Count -eq 0) { throw '国内站密钥一个都没有，清单内容不对。' }
if ($intlKeys.Count -eq 0) { throw '国际站密钥一个都没有，清单内容不对。' }

# ── 2. 校验：长度必须一致 ────────────────────────────────────────────────
#
# ⚠️ 这是本方案唯一不可妥协的前提。替换是**等长原地覆盖**：占位符与真密钥
#    长度不等就会错位 Content-Length，请求直接失败。宁可构建失败也不静默放过。

$allKeys = @($cnKeys) + @($intlKeys)
# ⚠️ 必须用 @() 包住：Sort-Object -Unique 只有一个结果时返回**标量**，
#    而 StrictMode 下标量没有 .Count（踩过）。
$lengths = @($allKeys | ForEach-Object { $_.Length } | Sort-Object -Unique)
if ($lengths.Count -ne 1) {
    $detail = ($allKeys | ForEach-Object { "$($_.Length)" } | Group-Object | ForEach-Object { "$($_.Name)字符×$($_.Count)" }) -join ', '
    throw "密钥长度不一致（$detail）。等长替换要求全部等长，请先剔除或补齐。"
}
$keyLen = $lengths[0]

# 占位符前缀必须与 keyinject.c 的 KI_PLACEHOLDER 一致，否则运行时匹配不到。
$source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
if ($source -notmatch 'KI_PLACEHOLDER\s+"(sk-ANON0+)"') {
    throw 'keyinject.c 里找不到 KI_PLACEHOLDER，无法校验占位符长度。'
}
$placeholder = $Matches[1]
if ($placeholder.Length -ne $keyLen) {
    throw "占位符 $($placeholder.Length) 字符，密钥 $keyLen 字符 —— 必须相等。`n请同步改 keyinject.c 的 KI_PLACEHOLDER。"
}

# ── 3. 混淆 ──────────────────────────────────────────────────────────────
#
# ⚠️ **这是混淆，不是加密。** mask 与滚动常量都在二进制里，有耐心的逆向者能还原。
#    它的作用只是把门槛从「会 strings」提到「会反汇编」。
#
#    每次构建都换一把新 mask：这样即使有人从某个版本里还原出明文，也无法用同一套
#    常量直接解开下一个版本（必须重新反汇编）。代价是不可复现构建 —— 对本项目
#    无影响，因为头文件与 .bin 都是生成物、不入库。

$mask = [byte[]]::new($keyLen)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($mask)

# ⚠️ 与 keyinject.c 的 derive_key() 必须逐字节一致，改一边必须同步改另一边。
# ⚠️ 必须用 `return ,$out`（逗号包住）：PowerShell 的 return 会**枚举**数组，
#    配合外层的 ForEach-Object 会把 7 个 51 字节的数组展平成 357 个独立字节，
#    后续 $enc[$i] 就变成了「对字节取下标」而越界（踩过）。
function Get-Scramble([string]$key) {
    $out = [byte[]]::new($keyLen)
    for ($i = 0; $i -lt $keyLen; $i++) {
        $out[$i] = [byte](([byte][char]$key[$i]) -bxor $mask[$i] -bxor (($i * 7 + 0x5A) -band 0xFF))
    }
    return ,$out
}

function Format-ByteArray([byte[]]$bytes, [string]$indent) {
    # 同上：单元素时管道返回标量，必须 @() 包住才有 .Count
    $cells = @($bytes | ForEach-Object { '0x{0:X2}' -f $_ })
    $lines = @()
    for ($i = 0; $i -lt $cells.Count; $i += 16) {
        $end = [Math]::Min($i + 15, $cells.Count - 1)
        $lines += $indent + ($cells[$i..$end] -join ', ')
    }
    return ($lines -join ",`n")
}

$cnEnc = @($cnKeys | ForEach-Object { Get-Scramble $_ })
$intlEnc = @($intlKeys | ForEach-Object { Get-Scramble $_ })

# ── 3.5 交错排列 ─────────────────────────────────────────────────────────
#
# ⚠️ 两站密钥**各存一张表**（国际站、国内站），由 keyinject.c 用
#    `keyref_at()` 按「偶数位国际、奇数位国内」的规则索引。交错而不是顺序排列，
#    是为了让两站配额同步消耗 —— 顺序排列时游标要等国际站 7 把全失效才轮到国内站。
#
#    这里只校验两表够不够交错：keyinject.c 用 `% count` 索引，所以两站数量不等
#    也能跑（少的那个会被循环复用），只是配额消耗不再均匀。

if ($intlKeys.Count -eq 0 -or $cnKeys.Count -eq 0) {
    throw '两个站点的密钥都必须有，combo 才能工作。'
}

# ── 4. 生成头文件 ────────────────────────────────────────────────────────

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('/*')
[void]$sb.AppendLine(' * keyinject-keys.h —— 自动生成，请勿手改。')
[void]$sb.AppendLine(' *')
[void]$sb.AppendLine(' * 由 tools/build-keyinject.ps1 从 agnes-keys.properties 生成（两者都不入库）。')
[void]$sb.AppendLine(' * 每次构建都会换一把新的混淆 mask，所以本文件不可复现 —— 这是有意的。')
[void]$sb.AppendLine(' *')
[void]$sb.AppendLine(' * ⚠️ 内容是**混淆**后的密钥，不是加密。算法见脚本的 Get-Scramble() 与')
[void]$sb.AppendLine(' *    keyinject.c 的 derive_key()，两处必须逐字节一致。')
[void]$sb.AppendLine(' */')
[void]$sb.AppendLine('#ifndef KEYINJECT_KEYS_H')
[void]$sb.AppendLine('#define KEYINJECT_KEYS_H')
[void]$sb.AppendLine('')
[void]$sb.AppendLine("#define KI_KEY_LEN $keyLen")
[void]$sb.AppendLine('')
[void]$sb.AppendLine('static const unsigned char KI_MASK[KI_KEY_LEN] = {')
[void]$sb.AppendLine((Format-ByteArray $mask '    '))
[void]$sb.AppendLine('};')
[void]$sb.AppendLine('')
[void]$sb.AppendLine("#define KI_CN_COUNT $($cnKeys.Count)")
[void]$sb.AppendLine('static const unsigned char KI_CN_ENC[KI_CN_COUNT][KI_KEY_LEN] = {')
foreach ($e in $cnEnc) {
    [void]$sb.AppendLine('    {')
    [void]$sb.AppendLine((Format-ByteArray $e '        '))
    [void]$sb.AppendLine('    },')
}
[void]$sb.AppendLine('};')
[void]$sb.AppendLine('')
[void]$sb.AppendLine("#define KI_INTL_COUNT $($intlKeys.Count)")
[void]$sb.AppendLine('static const unsigned char KI_INTL_ENC[KI_INTL_COUNT][KI_KEY_LEN] = {')
foreach ($e in $intlEnc) {
    [void]$sb.AppendLine('    {')
    [void]$sb.AppendLine((Format-ByteArray $e '        '))
    [void]$sb.AppendLine('    },')
}
[void]$sb.AppendLine('};')
[void]$sb.AppendLine('')
[void]$sb.AppendLine('#endif /* KEYINJECT_KEYS_H */')

Set-Content -LiteralPath $headerPath -Value $sb.ToString() -Encoding UTF8 -NoNewline

Write-Host "已生成 $headerPath"
Write-Host "  密钥长度   $keyLen 字符（占位符 $($placeholder.Length) 字符，已校验一致）"
Write-Host "  国内站     $($cnKeys.Count) 个"
Write-Host "  国际站     $($intlKeys.Count) 个"

# 自检：解回来必须与原文逐字一致，否则是加解密两边算法不一致（最贵的 bug）。
function Test-RoundTrip([string]$key, [byte[]]$enc) {
    $back = [char[]]::new($keyLen)
    for ($i = 0; $i -lt $keyLen; $i++) {
        $back[$i] = [char]($enc[$i] -bxor $mask[$i] -bxor (($i * 7 + 0x5A) -band 0xFF))
    }
    return (-join $back) -eq $key
}
for ($i = 0; $i -lt $cnKeys.Count; $i++) {
    if (-not (Test-RoundTrip $cnKeys[$i] $cnEnc[$i])) { throw "国内站第 $($i + 1) 个密钥往返校验失败。" }
}
for ($i = 0; $i -lt $intlKeys.Count; $i++) {
    if (-not (Test-RoundTrip $intlKeys[$i] $intlEnc[$i])) { throw "国际站第 $($i + 1) 个密钥往返校验失败。" }
}
Write-Host '  往返校验   全部通过'

if ($SkipBuild) {
    Write-Host '已跳过编译（-SkipBuild）。'
    return
}

# ── 5. 编译 ──────────────────────────────────────────────────────────────

if (-not (Test-Path $ndkClang)) { throw "找不到 NDK clang: $ndkClang" }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $assetPath) | Out-Null

# -shared -fPIC：LD_PRELOAD 库的标准形态。没有 -lssl：本库**不链接** OpenSSL，
# 只用 dlsym(RTLD_NEXT) 找真实符号，所以对 OpenSSL 版本完全不敏感。
& $ndkClang -shared -fPIC -O2 -Wall -Wextra -o $assetPath $sourcePath
if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }

$size = (Get-Item $assetPath).Length
Write-Host "已编译 $assetPath ($size 字节)"
