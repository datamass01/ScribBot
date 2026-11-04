#!/usr/bin/env bash
# Starts the ScribBot Console (http://127.0.0.1:7422/): one page to manage sessions, watch
# recording and transcription, and edit the settings in .env. Closing it, or the browser, stops
# nothing: the bot and the worker run the same whether or not it's open. Ctrl+C stops it.
# macOS and Linux; on Windows use start-console.ps1.
#
#   ./start-console.sh               # serve and open the page in your browser
#   ./start-console.sh --no-browser  # serve only
#   ./start-console.sh --port 7500   # another port (default: CONSOLE_PORT in .env, else 7422)
#   ./start-console.sh --no-log-file # don't copy the bot's log to data/logs (MONITOR_LOG_DIR)

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

console_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-browser)  console_args+=(--no-browser) ;;
    --no-log-file) console_args+=(--no-log-file) ;;
    --port)        [ $# -ge 2 ] || { echo "[console] --port needs a number" >&2; exit 2; }
                   console_args+=(--port "$2"); shift ;;
    --port=*)      console_args+=(--port "${1#--port=}") ;;
    -h|--help)     sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[console] Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# Standard library only, so any Python 3.10+ works, even before the worker is installed.
# Prefer the worker's venv if it exists.
python=""
if [ -x "$root/worker/.venv/bin/python" ]; then
  python="$root/worker/.venv/bin/python"
else
  for cand in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command -v "$cand" >/dev/null 2>&1 \
       && "$cand" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      python="$cand"; break
    fi
  done
fi
[ -n "$python" ] || { echo "[console] Python 3.10+ not found. Install it (see ./install.sh)." >&2; exit 1; }

[ -t 1 ] && printf '\e]0;ScribBot Console\a'
cd "$root/console"
exec "$python" -m scribconsole "${console_args[@]+"${console_args[@]}"}"
