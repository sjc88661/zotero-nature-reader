$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build.ps1')
& (Join-Path $releaseRoot 'bridge/scripts/build.ps1')
$bridgeManifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'bridge/addon/manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
Copy-Item -LiteralPath (Join-Path $releaseRoot "bridge/dist/obsidian-literature-bridge-$($bridgeManifest.version).xpi") -Destination (Join-Path $releaseRoot 'dist') -Force
