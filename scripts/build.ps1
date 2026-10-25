$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskAddon = Join-Path $taskRoot 'addon'
$taskDist = Join-Path $taskRoot 'dist'
$taskManifest = Get-Content -LiteralPath (Join-Path $taskAddon 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($taskScript in (Get-ChildItem -LiteralPath $taskAddon -Recurse -File -Filter '*.js')) {
    & node --check $taskScript.FullName
    if ($LASTEXITCODE -ne 0) { throw "Invalid JavaScript: $($taskScript.FullName)" }
}
foreach ($taskFile in (Get-ChildItem -LiteralPath (Join-Path $taskAddon 'content') -Filter '*.xhtml')) {
    $taskXml = New-Object System.Xml.XmlDocument
    $taskXml.Load($taskFile.FullName)
}
New-Item -ItemType Directory -Path $taskDist -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$taskPackage = Join-Path $taskDist "zotero-nature-reader-$($taskManifest.version).xpi"
if (Test-Path -LiteralPath $taskPackage) { Remove-Item -LiteralPath $taskPackage -Force }
$taskArchive = [System.IO.Compression.ZipFile]::Open($taskPackage, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($taskFile in (Get-ChildItem -LiteralPath $taskAddon -Recurse -File)) {
        $taskName = $taskFile.FullName.Substring($taskAddon.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $taskFile.FullName, $taskName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $taskArchive.Dispose() }
$taskArchive = [System.IO.Compression.ZipFile]::OpenRead($taskPackage)
try {
    foreach ($taskName in @('manifest.json','bootstrap.js','content/runtime.js','content/panel.xhtml','content/reader.xhtml')) {
        if (!$taskArchive.GetEntry($taskName)) { throw "XPI entry missing: $taskName" }
    }
} finally { $taskArchive.Dispose() }
Write-Output $taskPackage
