# Starts only the transcription worker (Python, Cactus Whistle) in this window, so you
# can watch its log while playing. Ctrl+C stops it.
# Works in Windows PowerShell 5.1 and PowerShell 7+.
#
#   .\start-worker.ps1          # run the worker in the foreground
#   .\start-worker.ps1 -Check   # load Whistle once first (downloads the weights on first use)
#   .\start-worker.ps1 -NoRestart  # don't restart it when it crashes
#
# Supervised: a crash (non-zero exit, e.g. the model couldn't be reloaded after a CUDA fault)
# restarts it after 5 s. On start it re-queues clips that weren't transcribed. Ctrl+C stops for good.
#
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\start-worker.ps1
# To start the worker and the bot together, use .\start.ps1 instead.

param(
    [switch]$Check,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$workerDir = Join-Path $root "worker"
$python = Join-Path $workerDir ".venv\Scripts\python.exe"

# --- Preflight -------------------------------------------------------------
if (-not (Test-Path (Join-Path $root ".env"))) {
    Write-Host "[worker] No .env found. Copy .env.example to .env and fill it in first." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $python)) {
    Write-Host "[worker] Worker venv missing. Run in $workerDir :" -ForegroundColor Red
    Write-Host "           py -3.13 -m venv .venv"
    Write-Host "           .venv\Scripts\pip install -e ."
    exit 1
}
& $python -c "import scribworker" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[worker] The scribworker package isn't installed in the venv. Run in $workerDir :" -ForegroundColor Red
    Write-Host "           .venv\Scripts\pip install -e ."
    exit 1
}

# STT_ENGINE=whisper needs the optional faster-whisper install.
$engine = Select-String -Path (Join-Path $root ".env") -Pattern '^\s*STT_ENGINE\s*=\s*(\S+)' | Select-Object -First 1
if ($engine -and $engine.Matches[0].Groups[1].Value.Trim('"', "'").ToLower() -eq "whisper") {
    & $python -c "import faster_whisper" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[worker] STT_ENGINE=whisper but faster-whisper isn't installed. Run in $workerDir :" -ForegroundColor Red
        Write-Host '           .venv\Scripts\pip install -e ".[whisper,cuda]"    (NVIDIA GPU)'
        Write-Host '           .venv\Scripts\pip install -e ".[whisper]"         (CPU only)'
        exit 1
    }
}

# Worker URL from .env (WORKER_URL), defaulting to the standard port.
$workerUrl = "http://127.0.0.1:7421"
$line = Select-String -Path (Join-Path $root ".env") -Pattern '^\s*WORKER_URL\s*=\s*(\S+)' | Select-Object -First 1
if ($line) { $workerUrl = $line.Matches[0].Groups[1].Value.Trim('"', "'").TrimEnd('/') }

try {
    $null = Invoke-RestMethod -Uri "$workerUrl/health" -TimeoutSec 2
    Write-Host "[worker] A worker is already running at $workerUrl. Close its window first (or find it with: netstat -ano | findstr :7421)." -ForegroundColor Yellow
    exit 1
} catch {
    # Nothing answering: good, start one.
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

# --- Run -------------------------------------------------------------------
$host.UI.RawUI.WindowTitle = "ScribBot worker ($workerUrl)"
Push-Location $workerDir
try {
    if ($Check) {
        Write-Host "[worker] Loading Whistle once to check the model..."
        & $python -m scribworker.check
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    Write-Host "[worker] Starting on $workerUrl (Ctrl+C to stop)..."
    $code = Invoke-Supervised "worker" { & $python -m scribworker }
    exit $code
} finally {
    Pop-Location
}
