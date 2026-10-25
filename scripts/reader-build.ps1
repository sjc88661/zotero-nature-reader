$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskInputs = @('backend/plugin.mjs','backend/engine.mjs','backend/harness.mjs','backend/service-host.mjs',
    'backend/layout.mjs','backend/layout.py','backend/reading-order.mjs','backend/reading_order.py',
    'backend/extract.py','backend/reading-flow.mjs','addon/content/paper-metadata.js','addon/content/reading-layout.js')
$taskLines = foreach ($taskInput in $taskInputs) { $taskInput + ':' + (Get-FileHash -LiteralPath (Join-Path $taskRoot $taskInput) -Algorithm SHA256).Hash }
$taskHash = [System.Security.Cryptography.SHA256]::Create()
try { ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($taskLines -join "`n"))))).Replace('-','') }
finally { $taskHash.Dispose() }
