param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$readerRoot = Split-Path -Parent $PSScriptRoot
& $Python -m venv (Join-Path $readerRoot '.venv')
if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python virtual environment.' }
& (Join-Path $readerRoot '.venv/Scripts/python.exe') -m pip install -r (Join-Path $readerRoot 'backend/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install PDF dependencies.' }
