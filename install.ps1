# Installs ScribBot on Windows. It first checks everything ScribBot needs and prints a checklist
# of what passed and what's missing. For prerequisites you install yourself (Node.js, Python,
# the Visual Studio C++ build tools) it shows the command to run and waits while you install
# them. Then it offers to set up the rest: the worker's Python venv, the bot's Node packages,
# .env, and the optional extras. Safe to run again: it reuses what exists and refreshes packages.
# Works in Windows PowerShell 5.1 and PowerShell 7+.
#
#   .\install.ps1              # check, then ask before installing anything
#   .\install.ps1 -Yes         # don't ask: install what's needed (also when input is redirected)
#   .\install.ps1 -Preflight   # only print the checklist (exit 1 if a prerequisite is missing)
#   .\install.ps1 -Whisper     # also faster-whisper for STT_ENGINE=whisper (CPU)
#   .\install.ps1 -Cuda        # faster-whisper with the NVIDIA CUDA libraries (implies -Whisper)
#   .\install.ps1 -Dev         # also the test dependencies (pytest, httpx)
#   .\install.ps1 -Check       # load the speech model at the end (downloads it on first use)
#   .\install.ps1 -Chromium    # download Playwright's Chromium for the Foundry bridge (Edge is the default)
#
# macOS and Linux: use ./install.sh instead.
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\install.ps1

param(
    [switch]$Yes,
    [switch]$Preflight,
    [switch]$Whisper,
    [switch]$Cuda,
    [switch]$Dev,
    [switch]$Check,
    [switch]$Chromium
)

# Probes below expect failures; each native call checks $LASTEXITCODE itself.
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$workerDir = Join-Path $root "worker"
$botDir = Join-Path $root "bot"
$venvPython = Join-Path $workerDir ".venv\Scripts\python.exe"
$envFile = Join-Path $root ".env"

if ($Cuda) { $Whisper = $true }
# Windows PowerShell 5.1 may not offer TLS 1.2 by default, which npm's registry and PyPI require.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$interactive = (-not $Yes) -and (-not [Console]::IsInputRedirected) -and [Environment]::UserInteractive
$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

function Step([string]$msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host "[install] $msg" -ForegroundColor Red; exit 1 }

# Ask "question" $true|$false: the user's answer, or the default when not interactive.
function Ask([string]$question, [bool]$default) {
    if (-not $interactive) { return $default }
    $hint = "[y/N]"
    if ($default) { $hint = "[Y/n]" }
    $reply = (Read-Host "$question $hint").Trim().ToLower()
    if ($reply -eq "") { return $default }
    return ($reply -eq "y" -or $reply -eq "yes")
}

# Run a native command quietly; $true when it exits 0. Never throws.
function Test-Native([string]$exe, [string[]]$arguments) {
    try {
        $null = & $exe @arguments 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# The value of KEY in .env (last match wins, as with dotenv), or "".
function Get-EnvValue([string]$key) {
    if (-not (Test-Path $envFile)) { return "" }
    $value = ""
    foreach ($line in Get-Content $envFile) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") {
            $value = ($Matches[1] -replace '\s+#.*$', '').Trim().Trim('"', "'")
        }
    }
    return $value
}

# Reload PATH from the registry, so tools installed in another window are found.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

# --- How to install each prerequisite -------------------------------------
function Hint-Node {
    if ($hasWinget) { return @("winget install OpenJS.NodeJS.LTS", "(or download the LTS installer from https://nodejs.org/)") }
    return @("Download the LTS installer from https://nodejs.org/")
}
function Hint-Python {
    if ($hasWinget) { return @("winget install Python.Python.3.13", "(or download it from https://www.python.org/downloads/; tick 'Add python.exe to PATH')") }
    return @("Download Python 3.13 from https://www.python.org/downloads/ (tick 'Add python.exe to PATH')")
}
function Hint-Venv {
    return @("This Python can't create virtual environments (no venv/ensurepip). Reinstall it:") + (Hint-Python)
}
function Hint-BuildTools {
    $lines = @()
    if ($hasWinget) {
        $lines += 'winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
    } else {
        $lines += "Install 'Build Tools for Visual Studio 2022' from https://visualstudio.microsoft.com/downloads/ with the 'Desktop development with C++' workload"
    }
    $lines += "(or rerun the Node.js installer and tick 'Automatically install the necessary tools')"
    return $lines
}

# --- Checklist ------------------------------------------------------------
$script:fails = 0
$script:warns = 0
$script:fixes = @()

function Row([string]$status, [string]$name, [string]$detail) {
    $tag = " -- "; $color = "DarkGray"
    switch ($status) {
        "ok"   { $tag = " ok "; $color = "Green" }
        "FAIL" { $tag = "FAIL"; $color = "Red"; $script:fails++ }
        "warn" { $tag = "warn"; $color = "Yellow"; $script:warns++ }
        "todo" { $tag = "todo"; $color = "Cyan" }
    }
    Write-Host "  [" -NoNewline
    Write-Host $tag -ForegroundColor $color -NoNewline
    Write-Host ("] {0,-26} {1}" -f $name, $detail)
}
function Need-Fix([string]$name, [string[]]$lines) {
    $script:fixes += , @($name, $lines)
}

function Get-PyVersion([string[]]$cmd) {
    $exe = $cmd[0]
    $pre = @()
    if ($cmd.Count -gt 1) { $pre = $cmd[1..($cmd.Count - 1)] }
    try {
        $out = & $exe @pre -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return [version]("$out".Trim()) }
    } catch { }
    return $null
}

function Find-Python {
    $script:python = $null
    $script:pythonVersion = $null
    $script:oldPython = $null
    if (Test-Path $venvPython) {
        $v = Get-PyVersion @($venvPython)
        if ($v) { $script:python = @($venvPython); $script:pythonVersion = $v; return }
    }
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($minor in "3.13", "3.12", "3.11", "3.10", "3") { $candidates += , @("py", "-$minor") }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) { $candidates += , @("python") }
    foreach ($c in $candidates) {
        $v = Get-PyVersion $c
        if (-not $v) { continue }
        if ($v -ge [version]"3.10") { $script:python = $c; $script:pythonVersion = $v; return }
        if (-not $script:oldPython) { $script:oldPython = $v }
    }
}

function Test-BuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $null }
    $path = & $vswhere -products * -latest -requiresAny `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 Microsoft.VisualStudio.Component.VC.Tools.ARM64 `
        -property displayName 2>$null
    if ($LASTEXITCODE -eq 0 -and $path) { return "$path".Trim() }
    return $null
}

function Test-Url([string]$url) {
    try {
        $null = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

function Run-Checks {
    $script:fails = 0
    $script:warns = 0
    $script:fixes = @()
    $nodeOk = $false

    Write-Host ""
    Write-Host "Prerequisites (you install these)" -ForegroundColor White

    # Node.js and npm
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $raw = "$(node --version 2>$null)".Trim().TrimStart('v')
        $nv = $null
        try { $nv = [version]($raw -replace '[^0-9.].*$', '') } catch { }
        if ($nv -and $nv -ge [version]"22.12") { Row ok "Node.js 22.12+" $raw; $nodeOk = $true }
        else { Row FAIL "Node.js 22.12+" "found $raw, too old"; Need-Fix "Node.js 22.12+" (Hint-Node) }
    } else {
        Row FAIL "Node.js 22.12+" "not found"; Need-Fix "Node.js 22.12+" (Hint-Node)
    }
    if (Get-Command npm -ErrorAction SilentlyContinue) { Row ok "npm" ("$(npm --version 2>$null)".Trim()) }
    elseif ($nodeOk) { Row FAIL "npm" "not found"; Need-Fix "npm" @("Reinstall Node.js from https://nodejs.org/; npm comes with it.") }
    else { Row skip "npm" "comes with Node.js" }

    # Python and venv
    Find-Python
    if ($script:python) {
        if ($script:python[0] -eq $venvPython) {
            Row ok "Python 3.10+" "$($script:pythonVersion) (worker venv)"
            Row ok "Python venv support" "venv already created"
        } else {
            Row ok "Python 3.10+" "$($script:pythonVersion) ($($script:python -join ' '))"
            $pre = @()
            if ($script:python.Count -gt 1) { $pre = $script:python[1..($script:python.Count - 1)] }
            if (Test-Native $script:python[0] ($pre + @("-c", "import venv, ensurepip"))) { Row ok "Python venv support" "venv + ensurepip" }
            else { Row FAIL "Python venv support" "missing venv/ensurepip"; Need-Fix "Python venv support" (Hint-Venv) }
        }
    } else {
        if ($script:oldPython) { Row FAIL "Python 3.10+" "found $($script:oldPython), too old" }
        else { Row FAIL "Python 3.10+" "not found" }
        Need-Fix "Python 3.10+" (Hint-Python)
        Row skip "Python venv support" "comes with Python"
    }

    # Network
    if ((Test-Url "https://registry.npmjs.org/") -and (Test-Url "https://pypi.org/simple/")) {
        Row ok "Internet access" "npm registry and PyPI reachable"
    } else {
        Row warn "Internet access" "can't reach registry.npmjs.org or pypi.org (offline or behind a proxy?)"
    }

    # Build tools. The bot's SQLite package (better-sqlite3) ships a prebuilt Windows binary, but
    # npm still runs node-gyp for it on every install, and node-gyp refuses to start without the
    # Visual Studio C++ build tools.
    $vs = Test-BuildTools
    if ($vs) { Row ok "C++ build tools" $vs }
    else { Row FAIL "C++ build tools" "Visual Studio C++ build tools not found (npm needs them for the SQLite package)"; Need-Fix "Visual Studio C++ build tools" (Hint-BuildTools) }

    # What .env and the options ask for
    $script:wantWhisper = [bool]$Whisper -or ((Get-EnvValue "STT_ENGINE").ToLower() -eq "whisper")
    $device = (Get-EnvValue "WHISPER_DEVICE").ToLower()
    if (-not $device) { $device = "cuda" }
    $script:wantCuda = [bool]$Cuda -or ($script:wantWhisper -and $device -eq "cuda")
    if ($script:wantCuda) {
        $gpu = $null
        if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
            $gpu = "$(nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)".Trim()
            if ($LASTEXITCODE -ne 0) { $gpu = $null }
        }
        if ($gpu) { Row ok "NVIDIA GPU driver" $gpu }
        else { Row warn "NVIDIA GPU driver" "not working: install it (https://www.nvidia.com/drivers) or set WHISPER_DEVICE=cpu" }
    }

    Write-Host ""
    Write-Host "ScribBot components (this script installs these)" -ForegroundColor White

    # Worker
    $script:needVenv = -not (Test-Path $venvPython)
    if ($script:needVenv) { Row todo "Worker venv" "will create worker\.venv" }
    else { Row ok "Worker venv" "worker\.venv" }
    if ((-not $script:needVenv) -and (Test-Native $venvPython @("-c", "import scribworker, fastapi, uvicorn, pydantic, numpy, dotenv, needle"))) {
        Row ok "Worker packages" "installed (will be refreshed)"
    } else {
        Row todo "Worker packages" "will install (Whistle speech-to-text, FastAPI)"
    }
    $script:needWhisper = $false
    if ($script:wantWhisper) {
        if ((-not $script:needVenv) -and (Test-Native $venvPython @("-c", "import faster_whisper"))) { Row ok "Whisper (faster-whisper)" "installed" }
        else { Row todo "Whisper (faster-whisper)" "will install (STT_ENGINE=whisper)"; $script:needWhisper = $true }
    }

    # Bot: loading better-sqlite3 proves its native binary works on this machine
    $botOk = $false
    if ($nodeOk -and (Test-Path (Join-Path $botDir "node_modules"))) {
        Push-Location $botDir
        $botOk = Test-Native "node" @("-e", "require('better-sqlite3')(':memory:').close(); require('discord.js')")
        Pop-Location
    }
    if ($botOk) { Row ok "Bot packages" "installed (will be refreshed)" }
    else { Row todo "Bot packages" "will run npm install in bot\" }

    # .env
    $script:needEnv = -not (Test-Path $envFile)
    if ($script:needEnv) { Row todo ".env" "will copy from .env.example" }
    else { Row ok ".env" "exists (kept as is)" }

    # Speech model (Whistle's cache is %USERPROFILE%\.cache\cactus-needle)
    $script:needModel = $false
    $whistle = Join-Path $env:USERPROFILE ".cache\cactus-needle\whistle"
    if ($script:wantWhisper) {
        Row skip "Speech model" "Whisper large-v3 (~3 GB) downloads when the worker first starts"
    } elseif (Get-ChildItem -Path $whistle -Filter *.cact -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1) {
        Row ok "Speech model" "Whistle downloaded"
    } else {
        Row todo "Speech model" "Whistle (~17 MB): now, or when the worker first starts"; $script:needModel = $true
    }

    # Foundry browser: only needed when the bot joins Foundry headlessly
    $script:needBrowser = $false
    $headless = (Get-EnvValue "FOUNDRY_HEADLESS").ToLower()
    if (-not $headless) { $headless = "off" }
    $browser = Get-EnvValue "FOUNDRY_BROWSER"
    if (-not $browser) { $browser = "msedge" }
    if ($Chromium) { $browser = "chromium" }
    if ($headless -eq "off" -and -not $Chromium) {
        Row skip "Foundry browser" "not needed (FOUNDRY_HEADLESS=off)"
    } elseif ($browser -eq "msedge") {
        $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($edge) { Row ok "Foundry browser" "Microsoft Edge" }
        else { Row warn "Foundry browser" "Edge not found; install it, or run .\install.ps1 -Chromium and set FOUNDRY_BROWSER=chromium" }
    } elseif ($browser -eq "chrome") {
        $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($chrome) { Row ok "Foundry browser" "Google Chrome" }
        else { Row warn "Foundry browser" "FOUNDRY_BROWSER=chrome, but Chrome isn't installed (https://www.google.com/chrome/)" }
    } elseif ($browser -eq "chromium") {
        $cache = $env:PLAYWRIGHT_BROWSERS_PATH
        if (-not $cache) { $cache = Join-Path $env:LOCALAPPDATA "ms-playwright" }
        if (Get-ChildItem -Path $cache -Filter "chromium*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1) {
            Row ok "Foundry browser" "Playwright Chromium"
        } else {
            Row todo "Foundry browser" "Playwright's Chromium (~150 MB)"; $script:needBrowser = $true
        }
    } elseif (Test-Path $browser) {
        Row ok "Foundry browser" $browser
    } else {
        Row warn "Foundry browser" "FOUNDRY_BROWSER=$browser isn't a file"
    }
}

function Show-Fixes {
    Write-Host ""
    Write-Host "Missing prerequisites. Install these yourself:" -ForegroundColor Red
    $i = 1
    foreach ($fix in $script:fixes) {
        Write-Host "  $i. $($fix[0])" -ForegroundColor White
        foreach ($line in $fix[1]) { Write-Host "       $line" }
        $i++
    }
}

# --- 1. Check, and wait while the user installs prerequisites -------------
Write-Host "ScribBot installer (Windows)" -ForegroundColor White
while ($true) {
    Run-Checks
    if ($script:fails -eq 0) { break }
    Show-Fixes
    Write-Host ""
    if ($Preflight -or -not $interactive) { Fail "Install the prerequisites above, then run .\install.ps1 again." }
    $reply = Read-Host "Install them (in another window), then press Enter to check again, or q to quit"
    if ($reply.Trim().ToLower() -eq "q") { exit 1 }
    Update-SessionPath
}

Write-Host ""
if ($script:warns -gt 0) { Write-Host "All prerequisites found, with $($script:warns) warning(s) above." -ForegroundColor Yellow }
else { Write-Host "All prerequisites found." -ForegroundColor Green }
if ($Preflight) { exit 0 }

# --- 2. Choose what to install --------------------------------------------
Write-Host ""
if ($script:needWhisper -and -not $Whisper) {
    if (Ask "Your .env uses STT_ENGINE=whisper. Install faster-whisper?" $true) { $Whisper = $true }
}
$extras = @()
if ($Whisper) { $extras += "whisper" }
if ($Whisper -and $script:wantCuda) {
    if ($Cuda -or (Ask "Also install the NVIDIA CUDA libraries, so Whisper runs on the GPU (~1 GB)?" $true)) { $extras += "cuda" }
}
if ($Dev) { $extras += "dev" }
$spec = "."
if ($extras.Count) { $spec = ".[" + ($extras -join ",") + "]" }

$doModel = [bool]$Check
if ($script:needModel -and -not $doModel) {
    $doModel = Ask "Download the Whistle speech model now (~17 MB)?" $true
}
$doBrowser = $false
if ($script:needBrowser) {
    $doBrowser = [bool]$Chromium -or (Ask "Download Playwright's Chromium for the Foundry bridge (~150 MB)?" $true)
}

Write-Host ""
Write-Host "This will:" -ForegroundColor White
if ($script:needVenv) { Write-Host "  - create the worker venv (worker\.venv) with Python $($script:pythonVersion)" }
Write-Host "  - install/refresh the worker's Python packages ($spec)"
Write-Host "  - install/refresh the bot's Node packages (npm install in bot\)"
if ($script:needEnv) { Write-Host "  - create .env from .env.example" }
if ($doModel) { Write-Host "  - load the speech model once (downloads it if needed)" }
if ($doBrowser) { Write-Host "  - download Playwright's Chromium" }
Write-Host ""
if (-not (Ask "Go ahead?" $true)) { Write-Host "Nothing was installed."; exit 0 }

# --- 3. Install -----------------------------------------------------------
$done = @()
if ($script:needVenv) {
    Step "Creating the worker venv in worker\.venv..."
    $exe = $script:python[0]
    $pre = @()
    if ($script:python.Count -gt 1) { $pre = $script:python[1..($script:python.Count - 1)] }
    & $exe @pre -m venv (Join-Path $workerDir ".venv")
    if ($LASTEXITCODE -ne 0) { Fail "Creating the venv failed. $((Hint-Venv) -join ' ')" }
    $done += "worker venv created"
}

Step "Installing the worker ($spec)..."
Push-Location $workerDir
& $venvPython -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -eq 0) { & $venvPython -m pip install -e $spec }
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail "Installing the worker failed; see the pip output above." }
$done += "worker packages ($spec)"

Step "Installing the bot's Node packages..."
Push-Location $botDir
npm install
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) {
    Fail "npm install failed. If the error mentions node-gyp or Visual Studio, install the C++ build tools ($((Hint-BuildTools)[0])) and run .\install.ps1 again."
}
$done += "bot packages"

if ($script:needEnv) {
    Copy-Item (Join-Path $root ".env.example") $envFile
    $done += ".env created from the template"
}

if ($doBrowser) {
    Step "Downloading Playwright's Chromium..."
    Push-Location $botDir
    npx playwright-core install chromium
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0) { $done += "Playwright Chromium (set FOUNDRY_BROWSER=chromium in .env to use it)" }
    else { Write-Host "[install] Downloading Chromium failed; the bot can't join Foundry headlessly with it until it's installed." -ForegroundColor Yellow }
}

if ($doModel) {
    Step "Loading the speech model once (downloads it on first use)..."
    Push-Location $workerDir
    & $venvPython -m scribworker.check
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0) { $done += "speech model loaded" }
    else { Write-Host "[install] The model check failed; see above. The worker tries again when it starts." -ForegroundColor Yellow }
}

# --- 4. Summary -----------------------------------------------------------
Write-Host ""
Write-Host "[install] Done." -ForegroundColor Green
foreach ($d in $done) {
    Write-Host "  [" -NoNewline; Write-Host " ok " -ForegroundColor Green -NoNewline; Write-Host "] $d"
}
Write-Host ""
Write-Host "Next:"
if ($script:needEnv) {
    Write-Host "  1. Fill in .env (DISCORD_TOKEN, DISCORD_CLIENT_ID, API_TOKEN, an LLM key),"
    Write-Host "     or run .\start-console.ps1 and use its Configuration tab."
} else {
    Write-Host "  1. Check .env, or run .\start-console.ps1 and use its Configuration tab."
}
Write-Host "  2. .\start.ps1 -Register    # first run: registers /scrib with Discord, then starts worker + bot"
Write-Host "  3. Install the ScribBot Bridge module in Foundry (see README, section 5)."
