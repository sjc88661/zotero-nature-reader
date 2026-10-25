param([string]$ProfilePath = (Join-Path $env:USERPROFILE '.dsh/profiles/desktop/cordis.patch.yml'))
$ErrorActionPreference = 'Stop'
$readerRoot = Split-Path -Parent $PSScriptRoot
$readerPython = Join-Path $readerRoot '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $readerPython)) { throw 'Run scripts/setup-python.ps1 first.' }
if (!(Test-Path -LiteralPath $ProfilePath)) { throw 'Harness profile not found. Pass -ProfilePath with your cordis.patch.yml path.' }
$readerSkills = Join-Path $env:USERPROFILE '.codex/skills'
foreach ($readerFile in @('nature-reader/SKILL.md','nature-reader/static/core/principles.md','nature-reader/static/core/workflow.md','nature-reader/static/core/output-contract.md','nature-reader/static/fragments/source/pdf-text.md','nature-reader/references/grounding-rules.md','nature-shared/core/terminology-ledger.md')) {
  if (!(Test-Path -LiteralPath (Join-Path $readerSkills $readerFile))) { throw "Missing external Nature skill resource: $readerFile. See docs/INSTALL.md." }
}
$readerBackup = Join-Path $readerRoot ('backups/harness-'+[guid]::NewGuid().ToString('N')+'.yml')
New-Item -ItemType Directory -Path (Split-Path -Parent $readerBackup) -Force | Out-Null
Copy-Item -LiteralPath $ProfilePath -Destination $readerBackup
$readerText = [System.IO.File]::ReadAllText($ProfilePath)
$readerStart = '# zotero-nature-reader begin'
$readerEnd = '# zotero-nature-reader end'
$readerFrom = $readerText.IndexOf($readerStart)
if ($readerFrom -ge 0) {
  $readerTo = $readerText.IndexOf($readerEnd, $readerFrom)
  if ($readerTo -lt 0) { throw 'Incomplete existing plugin entry; no changes were made.' }
  $readerText = $readerText.Remove($readerFrom, $readerTo+$readerEnd.Length-$readerFrom)
}
$readerUri = ([uri](Join-Path $readerRoot 'backend/plugin.mjs')).AbsoluteUri
$readerBuild = & (Join-Path $PSScriptRoot 'reader-build.ps1')
$readerReload = [guid]::NewGuid().ToString('N')
$readerEntry = "`r`n$readerStart`r`n- insert:`r`n    - id: zotero-nature-reader`r`n      name: '$readerUri`?build=$readerBuild&reload=$readerReload'`r`n$readerEnd`r`n"
[System.IO.File]::WriteAllText($ProfilePath, $readerText+$readerEntry, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Harness entry added. Completely quit and reopen Harness to load the plugin; closing only its window is insufficient.'
Write-Output ('Backup: '+$readerBackup)
