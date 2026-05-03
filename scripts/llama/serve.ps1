# 啟動 llama-server（PowerShell 版本，Windows 用）
# M-TCQ-SHIM：依 server.binaryKind 分流（buun 原生 binary | tcq vendored shim）
#
# 設定來源同 serve.sh：~/.my-agent/llamacpp.json 的 server.* 欄位 +
# 環境變數 LLAMA_HOST / LLAMA_PORT / LLAMA_CTX / LLAMA_NGL / LLAMA_ALIAS / LLAMA_BINARY_KIND 覆蓋
#
# 跨平台對齊原則（CLAUDE.md §10）：行為與 serve.sh 一致；
# extraArgs / mmproj 對應到的 ServerCommand flag 名稱由 TCQ-shim 負責對齊 buun llama-server。

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path

function Read-CfgValue {
    param([string]$JqPath, [string]$Default)
    $cfgFile = $env:LLAMACPP_CONFIG_PATH
    if (-not $cfgFile) {
        $jsoncPath = Join-Path $env:USERPROFILE ".my-agent\llamacpp.jsonc"
        $jsonPath  = Join-Path $env:USERPROFILE ".my-agent\llamacpp.json"
        if (Test-Path $jsoncPath) { $cfgFile = $jsoncPath }
        elseif (Test-Path $jsonPath) { $cfgFile = $jsonPath }
    }
    if (-not $cfgFile -or -not (Test-Path $cfgFile)) { return $Default }
    try {
        $raw = Get-Content $cfgFile -Raw
        # 去掉整行 // 註解（PowerShell 內建 JSON parser 不接受 JSONC）
        $clean = ($raw -split "`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
        $obj = $clean | ConvertFrom-Json
        $parts = $JqPath.TrimStart('.').Split('.')
        $cur = $obj
        foreach ($p in $parts) { $cur = $cur.$p; if ($null -eq $cur) { return $Default } }
        return $cur
    } catch { return $Default }
}

if (-not $env:LLAMA_HOST)         { $env:LLAMA_HOST = (Read-CfgValue '.server.host' '127.0.0.1') }
if (-not $env:LLAMA_PORT)         { $env:LLAMA_PORT = (Read-CfgValue '.server.port' 8080) }
if (-not $env:LLAMA_CTX)          { $env:LLAMA_CTX  = (Read-CfgValue '.server.ctxSize' 131072) }
if (-not $env:LLAMA_NGL)          { $env:LLAMA_NGL  = (Read-CfgValue '.server.gpuLayers' 99) }
if (-not $env:LLAMA_ALIAS)        { $env:LLAMA_ALIAS = (Read-CfgValue '.server.alias' 'qwen3.5-9b-neo') }
if (-not $env:LLAMA_MODEL_PATH)   { $env:LLAMA_MODEL_PATH = (Read-CfgValue '.server.modelPath' 'models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf') }
if (-not $env:LLAMA_BINARY)       { $env:LLAMA_BINARY = (Read-CfgValue '.server.binaryPath' 'llama/llama-server.exe') }
if (-not $env:LLAMA_BINARY_KIND)  { $env:LLAMA_BINARY_KIND = (Read-CfgValue '.server.binaryKind' 'buun') }

function Resolve-RepoPath {
    param([string]$P)
    if ([System.IO.Path]::IsPathRooted($P)) { return $P }
    return (Join-Path $RootDir $P)
}

$Model = Resolve-RepoPath $env:LLAMA_MODEL_PATH
if (-not (Test-Path $Model)) { Write-Error "[x] 找不到模型 $Model"; exit 1 }

$ExtraArgs = @()
$cfgExtra  = Read-CfgValue '.server.extraArgs' $null
if ($cfgExtra) { $ExtraArgs = @($cfgExtra) }
$mmproj = Read-CfgValue '.server.vision.mmprojPath' $null
if ($mmproj) {
    $ExtraArgs += '--mmproj'
    $ExtraArgs += (Resolve-RepoPath $mmproj)
}

if ($env:LLAMA_BINARY_KIND -eq 'tcq') {
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Write-Error "[x] 找不到 bun，TCQ-shim 需要 bun runtime"; exit 1
    }
    $ShimEntry = Join-Path $RootDir "vendor\node-llama-tcq\src\cli\cli.ts"
    if (-not (Test-Path $ShimEntry)) { Write-Error "[x] 找不到 $ShimEntry"; exit 1 }

    Write-Host "[*] 啟動 TCQ-shim（vendor/node-llama-tcq）"
    Write-Host "    model    = $(Split-Path $Model -Leaf)"
    Write-Host "    endpoint = http://$($env:LLAMA_HOST):$($env:LLAMA_PORT)/v1"
    Write-Host "    ctx      = $($env:LLAMA_CTX)    ngl = $($env:LLAMA_NGL)    alias = $($env:LLAMA_ALIAS)"
    Write-Host "    extra    = $($ExtraArgs -join ' ')"
    Write-Host ""

    $args = @(
        $ShimEntry, "serve",
        "--model", $Model,
        "--host", $env:LLAMA_HOST, "--port", $env:LLAMA_PORT,
        "--n-gpu-layers", $env:LLAMA_NGL,
        "--ctx-size", $env:LLAMA_CTX,
        "--alias", $env:LLAMA_ALIAS
    ) + $ExtraArgs
    & bun @args
    exit $LASTEXITCODE
}

# --- buun-llama-cpp 原生 binary -----------------------------------------
$Server = Resolve-RepoPath $env:LLAMA_BINARY
if (-not (Test-Path $Server)) { Write-Error "[x] 找不到 $Server"; exit 1 }

$SlotSavePath = if ($env:LLAMA_SLOT_SAVE_PATH) { $env:LLAMA_SLOT_SAVE_PATH } else { Join-Path $env:USERPROFILE ".cache\llama\slots" }
New-Item -ItemType Directory -Force -Path $SlotSavePath | Out-Null

Write-Host "[*] 啟動 llama-server"
Write-Host "    model   = $(Split-Path $Model -Leaf)"
Write-Host "    endpoint= http://$($env:LLAMA_HOST):$($env:LLAMA_PORT)/v1"
Write-Host "    ctx     = $($env:LLAMA_CTX)    ngl = $($env:LLAMA_NGL)    alias = $($env:LLAMA_ALIAS)"
Write-Host "    extra   = $($ExtraArgs -join ' ')"
Write-Host ""

$args = @(
    "--model", $Model,
    "--host", $env:LLAMA_HOST, "--port", $env:LLAMA_PORT,
    "--n-gpu-layers", $env:LLAMA_NGL,
    "--ctx-size", $env:LLAMA_CTX,
    "--alias", $env:LLAMA_ALIAS,
    "--slot-save-path", $SlotSavePath
) + $ExtraArgs
& $Server @args
exit $LASTEXITCODE
