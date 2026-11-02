# Starts the ScribBot Console (http://127.0.0.1:7422/): one page to manage sessions, watch
# recording and transcription, and edit the settings in .env. Closing it, or the browser, stops
# nothing: the bot and the worker run the same whether or not it's open. Ctrl+C stops it.
# Works in Windows PowerShell 5.1 and PowerShell 7+.
#
#   .\start-console.ps1               # serve and open the page in your browser
#   .\start-console.ps1 -NoBrowser    # serve only
#   .\start-console.ps1 -Port 7500    # another port (default: CONSOLE_PORT in .env, else 7422)
#   .\start-console.ps1 -NoLogFile    # don't copy the bot's log to data\logs (MONITOR_LOG_DIR)
#
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\start-console.ps1

param(
    [switch]$NoBrowser,
    [switch]$NoLogFile,
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# Standard library only, so any Python 3.10+ works, even before the worker is installed.
# Prefer the worker's venv if it exists.
$venvPython = Join-Path $root "worker\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    $python = @($venvPython)
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $python = @("py", "-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $python = @("python")
} else {
    Write-Host "[console] Python 3.10+ not found. Install it from python.org." -ForegroundColor Red
    exit 1
}

$consoleArgs = @("-m", "scribconsole")
if ($NoBrowser) { $consoleArgs += "--no-browser" }
if ($NoLogFile) { $consoleArgs += "--no-log-file" }
if ($Port -gt 0) { $consoleArgs += @("--port", "$Port") }

$host.UI.RawUI.WindowTitle = "ScribBot Console"
$exe = $python[0]
$pre = @()
if ($python.Count -gt 1) { $pre = $python[1..($python.Count - 1)] }
Push-Location (Join-Path $root "console")
try {
    & $exe @pre @consoleArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
