# Starts the transcription worker (in its own window) and then the bot.
# Works in Windows PowerShell 5.1 and PowerShell 7+.
#
#   .\start.ps1             # start worker + bot
#   .\start.ps1 -Register   # also (re)register the /scrib slash commands first
#
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\start.ps1

param(
    [switch]$Register
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
    Start-Process -FilePath $python -ArgumentList "-m", "scribworker" -WorkingDirectory $workerDir

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
    npm start
} finally {
    Pop-Location
}
