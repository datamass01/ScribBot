#!/usr/bin/env bash
# Starts the transcription worker (in the background, its output prefixed [worker]) and then the
# bot, in this terminal. macOS and Linux; on Windows use start.ps1.
#
#   ./start.sh               # start worker + bot
#   ./start.sh --register    # also (re)register the /scrib slash commands first
#   ./start.sh --no-restart  # don't restart the bot (or the worker) when it crashes
#
# Both run supervised: a crash (non-zero exit) restarts them after 5 s, and the bot then rejoins
# the voice channel of a session that was recording (RESUME_WINDOW_MINUTES). Exit code 75 (the
# Console's Restart buttons) starts them again at once. Ctrl+C (or SIGTERM) stops both for good;
# a worker that was already running before ./start.sh is left alone.
# Logs are in data/logs/ (bot-YYYY-MM-DD.log, worker-YYYY-MM-DD.log).

set -uo pipefail
set -m  # children run in their own process groups, so Ctrl+C reaches each once, through the trap

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bot_dir="$root/bot"
python="$root/worker/.venv/bin/python"

register=0 no_restart=0
for arg in "$@"; do
  case "$arg" in
    --register)   register=1 ;;
    --no-restart) no_restart=1 ;;
    -h|--help)    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[start] Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then red=$'\e[31m' yellow=$'\e[33m' cyan=$'\e[36m' reset=$'\e[0m'; else red='' yellow='' cyan='' reset=''; fi
say()  { echo "${2:-}[start] $1${reset}"; }
fail() { say "$1" "$red" >&2; exit 1; }

env_value() {
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)$/\1/p" "$root/.env" | tail -n1 \
    | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

# --- Preflight -------------------------------------------------------------
[ -f "$root/.env" ] || fail "No .env found. Run ./install.sh, or copy .env.example to .env and fill it in."
[ -x "$python" ] || fail "Worker venv missing. Run ./install.sh first."
command -v npm >/dev/null 2>&1 || fail "npm not found. Install Node.js 22.12+."

worker_url="$(env_value WORKER_URL)"
worker_url="${worker_url:-http://127.0.0.1:7421}"
worker_url="${worker_url%/}"

worker_up() {
  "$python" -c "import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)" "$worker_url/health" 2>/dev/null
}

# --- Signals and cleanup ---------------------------------------------------
child="" worker_pid="" stopping=0
on_signal() {
  stopping=1
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null
}
trap on_signal INT TERM HUP

stop_worker() {
  if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
    say "Stopping the worker..."
    kill -TERM "$worker_pid" 2>/dev/null
    wait "$worker_pid" 2>/dev/null
  fi
}
trap stop_worker EXIT

wait_child() {
  local rc
  while :; do
    wait "$child"; rc=$?
    kill -0 "$child" 2>/dev/null || return "$rc"
  done
}

# --- Worker ----------------------------------------------------------------
if worker_up; then
  say "Worker already running at $worker_url"
else
  say "Starting worker..."
  worker_args=()
  [ "$no_restart" = 1 ] && worker_args+=(--no-restart)
  # start-worker.sh supervises it too. Its lines get a [worker] prefix unless they already have one.
  "$root/start-worker.sh" "${worker_args[@]+"${worker_args[@]}"}" </dev/null \
    > >(awk '/^(\033\[[0-9;]*m)?\[worker\]/ { print; fflush(); next } { print "[worker] " $0; fflush() }') 2>&1 &
  worker_pid=$!

  deadline=$(( $(date +%s) + 60 ))
  until worker_up; do
    [ "$stopping" = 1 ] && exit 0
    kill -0 "$worker_pid" 2>/dev/null || fail "The worker exited during startup; see its output above."
    [ "$(date +%s)" -gt "$deadline" ] && fail "Worker did not answer at $worker_url/health within 60s. See its output above."
    sleep 1 & child=$!; wait_child; child=""
  done
  say "Worker is up at $worker_url"
fi

# --- Supervisor ------------------------------------------------------------
# Restart on a non-zero exit (a crash). A clean exit (code 0) or Ctrl+C/SIGTERM ends the loop.
# Exit code 75 is a requested restart: immediate, never counted.
# Gives up after 5 restarts within 10 minutes, so a broken setup doesn't spin forever.
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

# --- Bot -------------------------------------------------------------------
cd "$bot_dir" || exit 1
if [ ! -d node_modules ]; then
  say "Installing bot dependencies..."
  npm install || exit $?
fi
if [ "$register" = 1 ]; then
  say "Registering slash commands..."
  npm run register || exit $?
fi
say "Starting bot (Ctrl+C stops the bot and the worker)..."
# tsx directly rather than through npm, so SIGTERM reaches the bot without npm in between.
supervise bot "$bot_dir/node_modules/.bin/tsx" src/index.ts
exit $?
