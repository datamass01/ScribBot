#!/usr/bin/env bash
# Installs ScribBot on macOS and Linux. It first checks everything ScribBot needs and prints a
# checklist of what passed and what's missing. For prerequisites you install yourself (Node.js,
# Python) it shows the command for your system and waits while you install them. Then it offers
# to set up the rest: the worker's Python venv, the bot's Node packages, .env, and the optional
# extras. Safe to run again: it reuses what exists and refreshes the packages.
#
#   ./install.sh              # check, then ask before installing anything
#   ./install.sh --yes        # don't ask: install what's needed (also when not run in a terminal)
#   ./install.sh --preflight  # only print the checklist (exit 1 if a prerequisite is missing)
#   ./install.sh --whisper    # also faster-whisper for STT_ENGINE=whisper (CPU)
#   ./install.sh --cuda       # faster-whisper with the NVIDIA CUDA libraries (Linux; implies --whisper)
#   ./install.sh --dev        # also the test dependencies (pytest, httpx)
#   ./install.sh --check      # load the speech model at the end (downloads it on first use)
#   ./install.sh --chromium   # download Playwright's Chromium for the Foundry bridge
#
# Windows: use .\install.ps1 instead.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$root/worker"
bot_dir="$root/bot"
venv_python="$worker_dir/.venv/bin/python"

opt_whisper=0 opt_cuda=0 opt_dev=0 opt_check=0 opt_chromium=0 assume_yes=0 preflight=0
for arg in "$@"; do
  case "$arg" in
    --whisper)   opt_whisper=1 ;;
    --cuda)      opt_cuda=1; opt_whisper=1 ;;
    --dev)       opt_dev=1 ;;
    --check)     opt_check=1 ;;
    --chromium)  opt_chromium=1 ;;
    -y|--yes)    assume_yes=1 ;;
    --preflight) preflight=1 ;;
    -h|--help)   sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[install] Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done
interactive=0
[ -t 0 ] && [ -t 1 ] && [ "$assume_yes" = 0 ] && interactive=1

if [ -t 1 ]; then
  red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' cyan=$'\e[36m' dim=$'\e[2m' bold=$'\e[1m' reset=$'\e[0m'
else
  red='' green='' yellow='' cyan='' dim='' bold='' reset=''
fi
step() { echo "${cyan}[install] $*${reset}"; }
fail() { echo "${red}[install] $*${reset}" >&2; exit 1; }
lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# ask "question" y|n: the user's answer, or the default when not interactive
ask() {
  local q="$1" def="$2" prompt reply
  if [ "$interactive" = 0 ]; then [ "$def" = y ]; return; fi
  if [ "$def" = y ]; then prompt="[Y/n]"; else prompt="[y/N]"; fi
  read -r -p "${bold}$q $prompt${reset} " reply || reply=""
  reply="$(lower "$reply")"
  [ -z "$reply" ] && reply="$def"
  [ "$reply" = y ] || [ "$reply" = yes ]
}

# version_ge A B: true when version A >= version B (dotted numbers)
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]
}

env_value() {
  [ -f "$root/.env" ] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)$/\1/p" "$root/.env" | tail -n1 \
    | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

# --- Platform --------------------------------------------------------------
os=other distro="" pm=""
case "$(uname -s)" in
  Darwin) os=mac; command -v brew >/dev/null 2>&1 && pm=brew ;;
  Linux)
    os=linux
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      distro="$(. /etc/os-release; echo "${ID:-} ${ID_LIKE:-}")"
    fi
    case " $distro " in
      *" debian "*|*" ubuntu "*) pm=apt ;;
      *" fedora "*|*" rhel "*|*" centos "*) pm=dnf ;;
      *" arch "*) pm=pacman ;;
      *" suse "*|*" opensuse "*) pm=zypper ;;
    esac ;;
esac

# How to install each prerequisite on this system (one or more lines).
hint_node() {
  case "$pm" in
    brew)   echo "brew install node" ;;
    apt)    echo "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
            echo "sudo apt-get install -y nodejs"
            echo "(the distribution's own nodejs package is usually older than 22.12)" ;;
    dnf)    echo "sudo dnf install nodejs npm" ;;
    pacman) echo "sudo pacman -S nodejs npm" ;;
    zypper) echo "sudo zypper install nodejs22 npm22" ;;
    *)      if [ "$os" = mac ]; then
              echo "Download the LTS installer from https://nodejs.org/"
              echo "(or install Homebrew from https://brew.sh, then: brew install node)"
            else
              echo "Install nvm (https://github.com/nvm-sh/nvm), then: nvm install 22"
            fi ;;
  esac
  case "$pm" in dnf|pacman|zypper)
    echo "(if that gives a version older than 22.12: install nvm from https://github.com/nvm-sh/nvm, then: nvm install 22)" ;;
  esac
}
hint_npm() {
  case "$pm" in
    apt)    echo "sudo apt-get install -y npm   (NodeSource's nodejs package already includes it)" ;;
    dnf)    echo "sudo dnf install npm" ;;
    pacman) echo "sudo pacman -S npm" ;;
    zypper) echo "sudo zypper install npm22" ;;
    *)      echo "Reinstall Node.js from https://nodejs.org/; npm comes with it." ;;
  esac
}
hint_python() {
  case "$pm" in
    brew)   echo "brew install python@3.13" ;;
    apt)    echo "sudo apt-get install -y python3 python3-venv" ;;
    dnf)    echo "sudo dnf install python3" ;;
    pacman) echo "sudo pacman -S python" ;;
    zypper) echo "sudo zypper install python311" ;;
    *)      echo "Install Python 3.10 or newer from https://www.python.org/downloads/" ;;
  esac
}
hint_venv() {
  case "$pm" in
    apt)    echo "sudo apt-get install -y python${python_version}-venv" ;;
    zypper) echo "sudo zypper install python3-virtualenv" ;;
    *)      echo "This Python can't create virtual environments (no venv/ensurepip). Reinstall it:"
            hint_python ;;
  esac
}
hint_build() {
  case "$os/$pm" in
    mac/*)        echo "xcode-select --install" ;;
    linux/apt)    echo "sudo apt-get install -y build-essential   (make and a C++ compiler)" ;;
    linux/dnf)    echo "sudo dnf install gcc-c++ make" ;;
    linux/pacman) echo "sudo pacman -S base-devel" ;;
    linux/zypper) echo "sudo zypper install gcc-c++ make" ;;
    *)            echo "Install a C++ compiler and make." ;;
  esac
}

# --- Checklist -------------------------------------------------------------
# FAIL rows are prerequisites the user installs; "todo" rows are what this script sets up.
fails=0 warns=0
fix_list=()     # "name|command lines" for each missing prerequisite
row() {  # row ok|FAIL|warn|todo|skip name detail
  local tag color
  case "$1" in
    ok)   tag=" ok "; color="$green" ;;
    FAIL) tag="FAIL"; color="$red"; fails=$((fails + 1)) ;;
    warn) tag="warn"; color="$yellow"; warns=$((warns + 1)) ;;
    todo) tag="todo"; color="$cyan" ;;
    *)    tag=" -- "; color="$dim" ;;
  esac
  printf '  %s[%s]%s %-26s %s\n' "$color" "$tag" "$reset" "$2" "$3"
}
need_fix() { fix_list+=("$1|$2"); }

python="" python_version=""
want_whisper=0 want_cuda=0 need_venv=0 need_whisper=0 need_env=0 need_model=0 need_browser=0

find_python() {
  python="" python_version=""
  local old="" cand v
  if [ -x "$venv_python" ] && "$venv_python" -c 'import sys' 2>/dev/null; then
    python="$venv_python"
  else
    for cand in python3.13 python3.12 python3.11 python3.10 python3 python; do
      command -v "$cand" >/dev/null 2>&1 || continue
      v="$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
      [ -n "$v" ] || continue
      if version_ge "$v" "3.10"; then python="$cand"; break; fi
      [ -z "$old" ] && old="$v"
    done
  fi
  if [ -n "$python" ]; then
    python_version="$("$python" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  else
    python_version="$old"
  fi
}

can_reach() {  # can_reach URL, 5 s timeout
  if command -v curl >/dev/null 2>&1; then curl -fsS -o /dev/null -m 5 "$1" 2>/dev/null; return; fi
  [ -n "$python" ] && "$python" -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=5)" "$1" 2>/dev/null
}

run_checks() {
  fails=0 warns=0 fix_list=()
  local node_ok=0 v device headless browser pw_cache

  echo
  echo "${bold}Prerequisites (you install these)${reset}"

  # Node.js and npm
  if command -v node >/dev/null 2>&1; then
    v="$(node --version 2>/dev/null | sed 's/^v//')"
    if version_ge "$v" "22.12"; then row ok "Node.js 22.12+" "$v"; node_ok=1
    else row FAIL "Node.js 22.12+" "found $v, too old"; need_fix "Node.js 22.12+" "$(hint_node)"; fi
  else
    row FAIL "Node.js 22.12+" "not found"; need_fix "Node.js 22.12+" "$(hint_node)"
  fi
  if command -v npm >/dev/null 2>&1; then row ok "npm" "$(npm --version 2>/dev/null)"
  elif [ "$node_ok" = 1 ]; then row FAIL "npm" "not found"; need_fix "npm" "$(hint_npm)"
  else row skip "npm" "comes with Node.js"; fi

  # Python and venv
  find_python
  if [ -n "$python" ]; then
    if [ "$python" = "$venv_python" ]; then
      row ok "Python 3.10+" "$python_version (worker venv)"
      row ok "Python venv support" "venv already created"
    else
      row ok "Python 3.10+" "$python_version ($(command -v "$python"))"
      if "$python" -c 'import venv, ensurepip' 2>/dev/null; then row ok "Python venv support" "venv + ensurepip"
      else row FAIL "Python venv support" "missing venv/ensurepip"; need_fix "Python venv support" "$(hint_venv)"; fi
    fi
  else
    if [ -n "$python_version" ]; then row FAIL "Python 3.10+" "found $python_version, too old"
    else row FAIL "Python 3.10+" "not found"; fi
    need_fix "Python 3.10+" "$(hint_python)"
    row skip "Python venv support" "comes with Python"
  fi

  # Network
  if can_reach "https://registry.npmjs.org/" && can_reach "https://pypi.org/simple/"; then
    row ok "Internet access" "npm registry and PyPI reachable"
  else
    row warn "Internet access" "can't reach registry.npmjs.org or pypi.org (offline or behind a proxy?)"
  fi

  # Build tools. The bot's SQLite package (better-sqlite3) ships prebuilt binaries for
  # x64/arm64, but npm still runs node-gyp for it on every install, and node-gyp needs make
  # (on macOS: the Xcode Command Line Tools). Other CPUs compile SQLite, which needs a C++ compiler.
  local arch; arch="$(uname -m)"
  if [ "$os" = mac ]; then
    if xcode-select -p >/dev/null 2>&1; then row ok "Build tools (make)" "Xcode Command Line Tools"
    else row FAIL "Build tools (make)" "Xcode Command Line Tools not installed"; need_fix "Xcode Command Line Tools" "$(hint_build)"; fi
  elif ! command -v make >/dev/null 2>&1; then
    row FAIL "Build tools (make)" "make not found (npm needs it for the SQLite package)"; need_fix "Build tools (make)" "$(hint_build)"
  else
    case "$arch" in
      x86_64|amd64|aarch64|arm64) row ok "Build tools (make)" "$(command -v make)" ;;
      *) if command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1; then
           row ok "Build tools (make, C++)" "found ($arch compiles SQLite from source)"
         else
           row FAIL "C++ compiler" "$arch has no prebuilt SQLite, so npm compiles it"; need_fix "C++ compiler" "$(hint_build)"
         fi ;;
    esac
  fi

  # What .env and the options ask for
  want_whisper="$opt_whisper"
  [ "$(lower "$(env_value STT_ENGINE)")" = whisper ] && want_whisper=1
  device="$(lower "$(env_value WHISPER_DEVICE)")"; device="${device:-cuda}"
  want_cuda="$opt_cuda"
  [ "$want_whisper" = 1 ] && [ "$device" = cuda ] && want_cuda=1
  if [ "$want_cuda" = 1 ]; then
    if [ "$os" = mac ]; then
      row warn "NVIDIA GPU driver" "CUDA isn't available on macOS; set WHISPER_DEVICE=cpu in .env"
    elif command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
      row ok "NVIDIA GPU driver" "$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
    else
      row warn "NVIDIA GPU driver" "not working: install it (https://www.nvidia.com/drivers) or set WHISPER_DEVICE=cpu"
    fi
  fi

  echo
  echo "${bold}ScribBot components (this script installs these)${reset}"

  # Worker
  need_venv=0 need_whisper=0
  if [ -x "$venv_python" ]; then row ok "Worker venv" "worker/.venv"
  else row todo "Worker venv" "will create worker/.venv"; need_venv=1; fi
  if [ -x "$venv_python" ] && "$venv_python" -c 'import scribworker, fastapi, uvicorn, pydantic, numpy, dotenv, needle' 2>/dev/null; then
    row ok "Worker packages" "installed (will be refreshed)"
  else
    row todo "Worker packages" "will install (Whistle speech-to-text, FastAPI)"
  fi
  if [ "$want_whisper" = 1 ]; then
    if [ -x "$venv_python" ] && "$venv_python" -c 'import faster_whisper' 2>/dev/null; then row ok "Whisper (faster-whisper)" "installed"
    else row todo "Whisper (faster-whisper)" "will install (STT_ENGINE=whisper)"; need_whisper=1; fi
  fi

  # Bot: loading better-sqlite3 proves its native binary works on this machine
  if [ "$node_ok" = 1 ] && [ -d "$bot_dir/node_modules" ] \
     && (cd "$bot_dir" && node -e "require('better-sqlite3')(':memory:').close(); require('discord.js')") >/dev/null 2>&1; then
    row ok "Bot packages" "installed (will be refreshed)"
  else
    row todo "Bot packages" "will run npm install in bot/"
  fi

  # .env
  need_env=0
  if [ -f "$root/.env" ]; then row ok ".env" "exists (kept as is)"
  else row todo ".env" "will copy from .env.example"; need_env=1; fi

  # Speech model (Whistle's cache is ~/.cache/cactus-needle on every platform)
  need_model=0
  if [ "$want_whisper" = 1 ]; then
    row skip "Speech model" "Whisper large-v3 (~3 GB) downloads when the worker first starts"
  elif ls "$HOME/.cache/cactus-needle/whistle"/*/*.cact >/dev/null 2>&1; then
    row ok "Speech model" "Whistle downloaded"
  else
    row todo "Speech model" "Whistle (~17 MB): now, or when the worker first starts"; need_model=1
  fi

  # Foundry browser: only needed when the bot joins Foundry headlessly
  need_browser=0
  headless="$(lower "$(env_value FOUNDRY_HEADLESS)")"; headless="${headless:-off}"
  browser="$(env_value FOUNDRY_BROWSER)"; browser="${browser:-chromium}"
  if [ "$headless" = off ] && [ "$opt_chromium" = 0 ]; then
    row skip "Foundry browser" "not needed (FOUNDRY_HEADLESS=off)"
  elif [ "$browser" = chromium ] || [ "$opt_chromium" = 1 ]; then
    pw_cache="${PLAYWRIGHT_BROWSERS_PATH:-}"
    if [ -z "$pw_cache" ]; then
      if [ "$os" = mac ]; then pw_cache="$HOME/Library/Caches/ms-playwright"; else pw_cache="$HOME/.cache/ms-playwright"; fi
    fi
    if ls -d "$pw_cache"/chromium* >/dev/null 2>&1; then row ok "Foundry browser" "Playwright Chromium"
    else row todo "Foundry browser" "Playwright's Chromium (~150 MB)"; need_browser=1; fi
  elif [ "$browser" = chrome ]; then
    if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 \
       || [ -d "/Applications/Google Chrome.app" ]; then row ok "Foundry browser" "Google Chrome"
    else row warn "Foundry browser" "FOUNDRY_BROWSER=chrome, but Chrome isn't installed (https://www.google.com/chrome/)"; fi
  elif [ "$browser" = msedge ]; then
    if command -v microsoft-edge >/dev/null 2>&1 || [ -d "/Applications/Microsoft Edge.app" ]; then row ok "Foundry browser" "Microsoft Edge"
    else row warn "Foundry browser" "FOUNDRY_BROWSER=msedge, but Edge isn't installed; or set FOUNDRY_BROWSER=chromium"; fi
  elif [ -x "$browser" ]; then
    row ok "Foundry browser" "$browser"
  else
    row warn "Foundry browser" "FOUNDRY_BROWSER=$browser isn't an executable file"
  fi
}

print_fixes() {
  local i=1 item name cmds line
  echo
  echo "${red}${bold}Missing prerequisites. Install these yourself:${reset}"
  for item in ${fix_list[@]+"${fix_list[@]}"}; do
    name="${item%%|*}"; cmds="${item#*|}"
    echo "  $i. ${bold}$name${reset}"
    while IFS= read -r line; do echo "       $line"; done <<< "$cmds"
    i=$((i + 1))
  done
}

# --- 1. Check, and wait while the user installs prerequisites --------------
echo "${bold}ScribBot installer${reset} ($os${distro:+, ${distro%% *}})"
while :; do
  run_checks
  [ "$fails" = 0 ] && break
  print_fixes
  echo
  if [ "$preflight" = 1 ] || [ "$interactive" = 0 ]; then
    fail "Install the prerequisites above, then run ./install.sh again."
  fi
  read -r -p "${bold}Install them (in another terminal), then press Enter to check again, or q to quit:${reset} " reply || reply=q
  [ "$(lower "$reply")" = q ] && exit 1
  hash -r   # forget cached command paths, so a newly installed node or python is found
done

echo
if [ "$warns" -gt 0 ]; then echo "${yellow}All prerequisites found, with $warns warning(s) above.${reset}"
else echo "${green}All prerequisites found.${reset}"; fi
[ "$preflight" = 1 ] && exit 0

# --- 2. Choose what to install ---------------------------------------------
echo
if [ "$need_whisper" = 1 ] && [ "$opt_whisper" = 0 ]; then
  ask "Your .env uses STT_ENGINE=whisper. Install faster-whisper?" y && opt_whisper=1
fi
extras=()
[ "$opt_whisper" = 1 ] && extras+=("whisper")
if [ "$opt_whisper" = 1 ] && [ "$os" = linux ] && [ "$want_cuda" = 1 ]; then
  if [ "$opt_cuda" = 1 ] || ask "Also install the NVIDIA CUDA libraries, so Whisper runs on the GPU (~1 GB)?" y; then
    extras+=("cuda")
  fi
fi
[ "$opt_dev" = 1 ] && extras+=("dev")
spec="."
[ -n "${extras[*]+x}" ] && spec=".[$(IFS=,; echo "${extras[*]}")]"

do_model="$opt_check"
if [ "$need_model" = 1 ] && [ "$do_model" = 0 ]; then
  ask "Download the Whistle speech model now (~17 MB)?" y && do_model=1
fi
do_browser=0
if [ "$need_browser" = 1 ]; then
  if [ "$opt_chromium" = 1 ] || ask "Download Playwright's Chromium for the Foundry bridge (~150 MB)?" y; then do_browser=1; fi
fi

echo
echo "${bold}This will:${reset}"
[ "$need_venv" = 1 ] && echo "  - create the worker venv (worker/.venv) with Python $python_version"
echo "  - install/refresh the worker's Python packages ($spec)"
echo "  - install/refresh the bot's Node packages (npm install in bot/)"
[ "$need_env" = 1 ] && echo "  - create .env from .env.example"
[ "$do_model" = 1 ] && echo "  - load the speech model once (downloads it if needed)"
[ "$do_browser" = 1 ] && echo "  - download Playwright's Chromium"
echo
ask "Go ahead?" y || { echo "Nothing was installed."; exit 0; }

# --- 3. Install ------------------------------------------------------------
done_list=()
if [ "$need_venv" = 1 ]; then
  step "Creating the worker venv in worker/.venv..."
  "$python" -m venv "$worker_dir/.venv" || fail "Creating the venv failed. Fix: $(hint_venv | tr '\n' ' ')"
  done_list+=("worker venv created")
fi

step "Installing the worker ($spec)..."
(
  cd "$worker_dir" &&
  "$venv_python" -m pip install --upgrade pip --quiet &&
  "$venv_python" -m pip install -e "$spec"
) || fail "Installing the worker failed; see the pip output above."
done_list+=("worker packages ($spec)")

step "Installing the bot's Node packages..."
if ! (cd "$bot_dir" && npm install); then
  fail "npm install failed. If the error mentions node-gyp or a compiler, install the build tools ($(hint_build)) and run ./install.sh again."
fi
done_list+=("bot packages")

if [ "$need_env" = 1 ]; then
  cp "$root/.env.example" "$root/.env" && chmod 600 "$root/.env"
  done_list+=(".env created from the template")
fi

if [ "$do_browser" = 1 ]; then
  step "Downloading Playwright's Chromium..."
  if (cd "$bot_dir" && npx playwright-core install chromium); then done_list+=("Playwright Chromium")
  else echo "${yellow}[install] Downloading Chromium failed; the bot can't join Foundry headlessly until it's installed.${reset}"; fi
fi

if [ "$do_model" = 1 ]; then
  step "Loading the speech model once (downloads it on first use)..."
  if (cd "$worker_dir" && "$venv_python" -m scribworker.check); then done_list+=("speech model loaded")
  else echo "${yellow}[install] The model check failed; see above. The worker tries again when it starts.${reset}"; fi
fi

# --- 4. Summary ------------------------------------------------------------
echo
echo "${green}${bold}[install] Done.${reset}"
for d in ${done_list[@]+"${done_list[@]}"}; do echo "  ${green}[ ok ]${reset} $d"; done
echo
echo "Next:"
if [ "$need_env" = 1 ]; then
  echo "  1. Fill in .env (DISCORD_TOKEN, DISCORD_CLIENT_ID, API_TOKEN, an LLM key),"
  echo "     or run ./start-console.sh and use its Configuration tab."
else
  echo "  1. Check .env, or run ./start-console.sh and use its Configuration tab."
fi
echo "  2. ./start.sh --register    # first run: registers /scrib with Discord, then starts worker + bot"
echo "  3. Install the ScribBot Bridge module in Foundry (see README, section 5)."
