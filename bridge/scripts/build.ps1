$ErrorActionPreference = 'Stop'
$taskProject = Split-Path -Parent $PSScriptRoot
$taskAddon = Join-Path $taskProject 'addon'
# The reader owns the shared metadata detector; retain the vendored copy when
# building the bridge by itself.
$taskMetadataSource = Join-Path (Split-Path -Parent $taskProject) 'addon\content\paper-metadata.js'
if (Test-Path -LiteralPath $taskMetadataSource) { Copy-Item -LiteralPath $taskMetadataSource -Destination (Join-Path $taskAddon 'content\paper-metadata.js') -Force }
$taskLayoutSource = Join-Path (Split-Path -Parent $taskProject) 'addon\content\reading-layout.js'
if (Test-Path -LiteralPath $taskLayoutSource) { Copy-Item -LiteralPath $taskLayoutSource -Destination (Join-Path $taskAddon 'content\reading-layout.js') -Force }
$taskDist = Join-Path $taskProject 'dist'
$taskManifest = Get-Content -LiteralPath (Join-Path $taskAddon 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($taskManifest.applications.zotero.update_url -notmatch '^https:') { throw 'Zotero requires an HTTPS applications.zotero.update_url; a file URL disables the add-on.' }
$taskNode = (Get-Command node -ErrorAction Stop).Source
foreach ($taskScript in (Get-ChildItem -LiteralPath $taskAddon -Recurse -File -Filter '*.js')) {
    & $taskNode --check $taskScript.FullName
    if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax check failed: $($taskScript.Name)" }
}
$taskXml = New-Object System.Xml.XmlDocument
$taskXml.Load((Join-Path $taskAddon 'content\manager.xhtml'))
New-Item -ItemType Directory -Path $taskDist -Force | Out-Null
$taskPackage = Join-Path $taskDist "obsidian-literature-bridge-$($taskManifest.version).xpi"
if (Test-Path -LiteralPath $taskPackage) { Remove-Item -LiteralPath $taskPackage -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$taskArchive = [System.IO.Compression.ZipFile]::Open($taskPackage, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    # Windows PowerShell's .NET Framework uses backslashes in CreateFromDirectory;
    # Gecko's jar: loader requires portable forward-slash ZIP entry names.
    foreach ($taskFile in (Get-ChildItem -LiteralPath $taskAddon -Recurse -File)) {
        $taskEntryName = $taskFile.FullName.Substring($taskAddon.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $taskFile.FullName, $taskEntryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $taskArchive.Dispose() }
$taskArchive = [System.IO.Compression.ZipFile]::OpenRead($taskPackage)
try {
    foreach ($taskRequired in @('bootstrap.js', 'manifest.json', 'content/runtime.js', 'content/annotations.js')) {
        if (!$taskArchive.GetEntry($taskRequired)) { throw "XPI entry missing: $taskRequired" }
    }
} finally { $taskArchive.Dispose() }
Write-Output $taskPackage
