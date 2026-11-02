# Moved: the watchdog is now the ScribBot Console. This starts .\start-console.ps1 with the same
# options, so existing shortcuts keep working.
param(
    [switch]$NoBrowser,
    [switch]$NoLogFile,
    [int]$Port = 0
)
& (Join-Path $PSScriptRoot "start-console.ps1") -NoBrowser:$NoBrowser -NoLogFile:$NoLogFile -Port $Port
exit $LASTEXITCODE
