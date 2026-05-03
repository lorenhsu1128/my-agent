# 重建 node_modules/node-llama-tcq 為 junction 指向 vendor/node-llama-tcq
# 因為 npm install 預設會把 file: dep 複製到 node_modules，但 .gitignore
# 排除的 localBuilds（含 .node addon 與 DLL）不會被複製過去。
# 用 junction 直接 alias 到 vendor 目錄，讓 runtime 找得到 native binaries。
#
# 用途：每次 npm install / bun install 後跑一次。
# 跑法：pwsh -File scripts/setup-node-llama-tcq.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$target   = Join-Path $repoRoot 'vendor/node-llama-tcq'
$linkPath = Join-Path $repoRoot 'node_modules/node-llama-tcq'

if (-not (Test-Path $target)) {
    Write-Error "vendor/node-llama-tcq 不存在: $target"
    exit 1
}

if (Test-Path $linkPath) {
    Remove-Item -Recurse -Force $linkPath
}

# Junction 不需 admin，重新導向到 vendor
New-Item -ItemType Junction -Path $linkPath -Target $target | Out-Null

$nodeFile = Join-Path $linkPath 'llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_aecbbd5/Release/llama-addon.node'
if (Test-Path $nodeFile) {
    Write-Host "✓ junction 建好：$linkPath → $target"
    Write-Host "✓ .node addon 可見：$nodeFile"
} else {
    Write-Host "✓ junction 建好但 .node 還沒編：cd vendor/node-llama-tcq; node ./dist/cli/cli.js source build --gpu cuda"
}
