#!/usr/bin/env bash
# Starts only the transcription worker (Python, Cactus Whistle) in this terminal, so you can
# watch its log while playing. Ctrl+C stops it. macOS and Linux; on Windows use start-worker.ps1.
#
#   ./start-worker.sh              # run the worker in the foreground
#   ./start-worker.sh --check      # load Whistle once first (downloads the weights on first use)
#   ./start-worker.sh --no-restart # don't restart it when it crashes
#
# Supervised: a crash (non-zero exit, e.g. the model couldn't be reloaded after a CUDA fault)
# restarts it after 5 s. Exit code 75 (the Console's Restart worker) starts it again at once.
# On start it re-queues clips that weren't transcribed. Ctrl+C (or SIGTERM) stops for good.
# To start the worker and the bot together, use ./start.sh instead.

set -uo pipefail
set -m  # the worker runs in its own process group, so Ctrl+C reaches it once, through the trap

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$root/worker"
python="$worker_dir/.venv/bin/python"

check=0 no_restart=0
for arg in "$@"; do
  case "$arg" in
    --check)      check=1 ;;
    --no-restart) no_restart=1 ;;
    -h|--help)    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[worker] Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then red=$'\e[31m' yellow=$'\e[33m' cyan=$'\e[36m' reset=$'\e[0m'; else red='' yellow='' cyan='' reset=''; fi
say()  { echo "${2:-}[worker] $1${reset}"; }
fail() { say "$1" "$red" >&2; exit 1; }

# env_value KEY: the value of KEY in .env (first match, quotes stripped), or empty
env_value() {
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)$/\1/p" "$root/.env" | tail -n1 \
    | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

# --- Preflight -------------------------------------------------------------
[ -f "$root/.env" ] || fail "No .env found. Run ./install.sh, or copy .env.example to .env and fill it in."
[ -x "$python" ] || fail "Worker venv missing. Run ./install.sh first."
"$python" -c "import scribworker" 2>/dev/null \
  || fail "The scribworker package isn't installed in the venv. Run ./install.sh first."

engine="$(env_value STT_ENGINE | tr '[:upper:]' '[:lower:]')"
if [ "$engine" = whisper ] && ! "$python" -c "import faster_whisper" 2>/dev/null; then
  fail "STT_ENGINE=whisper but faster-whisper isn't installed. Run ./install.sh --cuda (NVIDIA GPU) or ./install.sh --whisper (CPU only)."
fi

worker_url="$(env_value WORKER_URL)"
worker_url="${worker_url:-http://127.0.0.1:7421}"
worker_url="${worker_url%/}"

if "$python" -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)" "$worker_url/health" 2>/dev/null; then
  fail "A worker is already running at $worker_url. Stop it first (find it with: lsof -i :${worker_url##*:})."
fi

# --- Supervisor ------------------------------------------------------------
# Restart on a non-zero exit (a crash). A clean exit (code 0) or Ctrl+C/SIGTERM ends the loop.
# Exit code 75 is a requested restart: immediate, never counted.
# Gives up after 5 restarts within 10 minutes, so a broken setup doesn't spin forever.
child="" stopping=0
on_signal() {
  stopping=1
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
}
trap on_signal INT TERM HUP

wait_child() {
  local rc
  while :; do
    wait "$child"; rc=$?
    kill -0 "$child" 2>/dev/null || return "$rc"
  done
}

supervise() {
  local name="$1"; shift
  local restarts=() code now kept t
  while :; do
    "$@" </dev/null &
    child=$!
    wait_child; code=$?
    child=""
    [ "$stopping" = 1 ] && return 0
    if [ "$code" -eq 75 ]; then
      echo "${cyan}[$name] restarting as requested...${reset}"
      continue
    fi
    if [ "$code" -eq 0 ] || [ "$no_restart" = 1 ]; then return "$code"; fi
    now="$(date +%s)"
    kept=()
    for t in "${restarts[@]+"${restarts[@]}"}"; do [ "$t" -ge $((now - 600)) ] && kept+=("$t"); done
    restarts=("${kept[@]+"${kept[@]}"}" "$now")
    if [ "${#restarts[@]}" -gt 5 ]; then
      echo "${red}[$name] exited with code $code; ${#restarts[@]} restarts in 10 minutes, giving up. See data/logs/ for why.${reset}" >&2
      return "$code"
    fi
    echo "${yellow}[$name] exited with code $code; restarting in 5 s (Ctrl+C to stop)...${reset}"
    sleep 5 & child=$!; wait_child; child=""
    [ "$stopping" = 1 ] && return 0
  done
}

# --- Run -------------------------------------------------------------------
[ -t 1 ] && printf '\e]0;ScribBot worker (%s)\a' "$worker_url"
cd "$worker_dir" || exit 1
if [ "$check" = 1 ]; then
  say "Loading Whistle once to check the model..."
  "$python" -m scribworker.check || exit $?
fi
say "Starting on $worker_url (Ctrl+C to stop)..."
supervise worker "$python" -m scribworker
exit $?
