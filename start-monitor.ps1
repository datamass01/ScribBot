# Starts the optional ScribBot watchdog (http://127.0.0.1:7422/). While the bot runs, that address
# redirects to the bot's dashboard (http://127.0.0.1:7420), the one page to watch. While the bot is
# down it shows a crash notice, the worker queue, whether it's safe to shut down, and the bot's last
# log lines. It only reads; the bot and worker run the same whether or not it's open. Ctrl+C stops it.
# Works in Windows PowerShell 5.1 and PowerShell 7+.
#
#   .\start-monitor.ps1               # serve and open the page in your browser
#   .\start-monitor.ps1 -NoBrowser    # serve only
#   .\start-monitor.ps1 -Port 7500    # another port (default: MONITOR_PORT in .env, else 7422)
#   .\start-monitor.ps1 -NoLogFile    # don't copy the bot's log to data\logs (MONITOR_LOG_DIR)
#
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\start-monitor.ps1

param(
    [switch]$NoBrowser,
    [switch]$NoLogFile,
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$script = Join-Path $root "monitor\scribmonitor.py"

# Standard library only, so any Python 3.10+ works. Prefer the worker's venv if it exists.
$venvPython = Join-Path $root "worker\.venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    $python = @($venvPython)
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $python = @("py", "-3")
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $python = @("python")
} else {
    Write-Host "[monitor] Python 3.10+ not found. Install it from python.org or create the worker venv." -ForegroundColor Red
    exit 1
}

$scriptArgs = @($script)
if ($NoBrowser) { $scriptArgs += "--no-browser" }
if ($NoLogFile) { $scriptArgs += "--no-log-file" }
if ($Port -gt 0) { $scriptArgs += @("--port", "$Port") }

$host.UI.RawUI.WindowTitle = "ScribBot monitor"
$exe = $python[0]
$pre = @()
if ($python.Count -gt 1) { $pre = $python[1..($python.Count - 1)] }
& $exe @pre @scriptArgs
exit $LASTEXITCODE
