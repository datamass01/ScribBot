# Builds releases/scribbot-bridge.zip from foundry-module/ for Foundry's
# "Install Module -> Manifest URL". Module files sit at the zip root and entry
# paths use forward slashes (Compress-Archive in PowerShell 5.1 writes
# backslashes, which break on Linux-hosted Foundry).
#
#   .\package-foundry-module.ps1
#
# Bump "version" in foundry-module/module.json before packaging a new release,
# then commit both module.json and the zip; Foundry offers the update once
# they're on main.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$src = Join-Path $PSScriptRoot "foundry-module"
$outDir = Join-Path $PSScriptRoot "releases"
$zipPath = Join-Path $outDir "scribbot-bridge.zip"

$manifest = Get-Content (Join-Path $src "module.json") -Raw | ConvertFrom-Json
foreach ($field in "manifest", "download") {
    if (-not $manifest.$field) { throw "module.json has no '$field' field." }
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path $zipPath) { Remove-Item $zipPath }

$srcFull = (Resolve-Path $src).Path.TrimEnd('\') + '\'
$files = Get-ChildItem -Path $src -Recurse -File |
    Where-Object { $_.Extension -ne ".zip" } |
    Sort-Object FullName

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        $entry = $f.FullName.Substring($srcFull.Length).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $f.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        Write-Host "  + $entry"
    }
} finally {
    $zip.Dispose()
}

Write-Host "[package] Built $zipPath (ScribBot Bridge v$($manifest.version))"
