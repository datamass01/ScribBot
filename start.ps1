# Starts the transcription worker (in its own window) and then the bot.
# Works in Windows PowerShell 5.1 and PowerShell 7+.
#
#   .\start.ps1             # start worker + bot
#   .\start.ps1 -Register   # also (re)register the /scrib slash commands first
#   .\start.ps1 -NoRestart  # don't restart the bot (or the worker) when it crashes
#
# Both run supervised: a crash (non-zero exit) restarts them after 5 s, and the bot then rejoins
# the voice channel of a session that was recording (RESUME_WINDOW_MINUTES). Ctrl+C stops for good.
# Logs are in data\logs\ (bot-YYYY-MM-DD.log, worker-YYYY-MM-DD.log).
#
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\start.ps1

param(
    [switch]$Register,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$workerDir = Join-Path $root "worker"
$botDir = Join-Path $root "bot"
$python = Join-Path $workerDir ".venv\Scripts\python.exe"

# --- Preflight -------------------------------------------------------------
if (-not (Test-Path (Join-Path $root ".env"))) {
    Write-Host "[start] No .env found. Copy .env.example to .env and fill it in first." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $python)) {
    Write-Host "[start] Worker venv missing. Run in $workerDir :" -ForegroundColor Red
    Write-Host "          py -3.13 -m venv .venv"
    Write-Host "          .venv\Scripts\pip install -e ."
    exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "[start] npm not found. Install Node.js 22.12+." -ForegroundColor Red
    exit 1
}

# Worker URL from .env (WORKER_URL), defaulting to the standard port.
$workerUrl = "http://127.0.0.1:7421"
$line = Select-String -Path (Join-Path $root ".env") -Pattern '^\s*WORKER_URL\s*=\s*(\S+)' | Select-Object -First 1
if ($line) { $workerUrl = $line.Matches[0].Groups[1].Value.Trim('"', "'").TrimEnd('/') }
$healthUrl = "$workerUrl/health"

function Test-Worker {
    try {
        $null = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return $true
    } catch {
        return $false
    }
}

# --- Worker ----------------------------------------------------------------
if (Test-Worker) {
    Write-Host "[start] Worker already running at $workerUrl"
} else {
    Write-Host "[start] Starting worker in a new window..."
    # Through start-worker.ps1, so the worker window is supervised too.
    $shell = (Get-Process -Id $PID).Path
    $workerArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "start-worker.ps1"))
    if ($NoRestart) { $workerArgs += "-NoRestart" }
    Start-Process -FilePath $shell -ArgumentList $workerArgs -WorkingDirectory $root

    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Worker)) {
        if ((Get-Date) -gt $deadline) {
            Write-Host "[start] Worker did not answer at $healthUrl within 60s. Check its window for errors." -ForegroundColor Red
            exit 1
        }
        Start-Sleep -Seconds 1
    }
    Write-Host "[start] Worker is up at $workerUrl"
}

# --- Supervisor (docs/assessment/02 S3) -----------------------------------
# Restart on a non-zero exit (a crash). A clean exit (Ctrl+C, code 0) ends the loop.
# Gives up after 5 restarts within 10 minutes, so a broken setup doesn't spin forever.
function Invoke-Supervised([string]$Name, [scriptblock]$Run) {
    $restarts = New-Object System.Collections.Generic.List[datetime]
    while ($true) {
        & $Run
        $code = $LASTEXITCODE
        if ($code -eq 0 -or $NoRestart) { return $code }
        $now = Get-Date
        $restarts.Add($now)
        while ($restarts.Count -and $restarts[0] -lt $now.AddMinutes(-10)) { $restarts.RemoveAt(0) }
        if ($restarts.Count -gt 5) {
            Write-Host "[$Name] exited with code $code; $($restarts.Count) restarts in 10 minutes, giving up. See data\logs\ for why." -ForegroundColor Red
            return $code
        }
        Write-Host "[$Name] exited with code $code; restarting in 5 s (Ctrl+C to stop)..." -ForegroundColor Yellow
        Start-Sleep -Seconds 5
    }
}

# --- Bot -------------------------------------------------------------------
Push-Location $botDir
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host "[start] Installing bot dependencies..."
        npm install
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if ($Register) {
        Write-Host "[start] Registering slash commands..."
        npm run register
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    Write-Host "[start] Starting bot (Ctrl+C to stop; close the worker window separately)..."
    $code = Invoke-Supervised "bot" { npm start }
    exit $code
} finally {
    Pop-Location
}
