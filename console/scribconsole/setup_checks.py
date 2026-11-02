"""The setup checklist on the Configuration tab. Each check only reads (files, `node --version`,
the status the Monitoring tab already has) and says how to fix what's missing."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

MIN_NODE = (22, 12)


def _check(id: str, label: str, state: str, detail: str = "", fix: str = "") -> dict[str, str]:
    return {"id": id, "label": label, "state": state, "detail": detail, "fix": fix}


class NodeVersion:
    """`node --version`, at most once a minute (it's a process start)."""

    def __init__(self, run: Callable[[], str | None] | None = None):
        self._run = run or self._node
        self._lock = threading.Lock()
        self._cached: tuple[float, str | None] | None = None

    @staticmethod
    def _node() -> str | None:
        exe = shutil.which("node")
        if not exe:
            return None
        try:
            out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=5,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return out.stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            return None

    def get(self) -> str | None:
        with self._lock:
            if self._cached and time.monotonic() - self._cached[0] < 60:
                return self._cached[1]
            value = self._run()
            self._cached = (time.monotonic(), value)
            return value


def run_checks(repo: Path, values: dict[str, Any], status: dict[str, Any], node: NodeVersion, env_exists: bool) -> list[dict[str, str]]:
    """`values`: Settings.view()["values"]. `status`: Monitor.status()."""
    def val(key: str) -> str:
        v = values.get(key) or {}
        return v.get("value", "") if "value" in v else ("set" if v.get("set") else "")

    checks: list[dict[str, str]] = []
    bot_online = (status.get("monitor") or {}).get("bot") == "online"

    checks.append(_check("env", ".env settings file", "ok" if env_exists else "err",
                         "" if env_exists else "There's no .env yet.",
                         "" if env_exists else "Use “Create .env from the template” below, then fill in the settings."))

    version = node.get()
    m = re.match(r"v(\d+)\.(\d+)", version or "")
    if not version:
        checks.append(_check("node", "Node.js 22.12 or later", "err", "node wasn't found on PATH.", "Install Node.js LTS from nodejs.org."))
    elif not m or (int(m[1]), int(m[2])) < MIN_NODE:
        checks.append(_check("node", "Node.js 22.12 or later", "err", f"Found {version}.", "Install a newer Node.js LTS from nodejs.org."))
    else:
        checks.append(_check("node", "Node.js 22.12 or later", "ok", version))

    has_modules = (repo / "bot" / "node_modules").is_dir()
    checks.append(_check("bot-deps", "Bot packages installed", "ok" if has_modules else "warn",
                         "" if has_modules else "bot\\node_modules is missing.",
                         "" if has_modules else "start.ps1 installs them on its first run, or run: cd bot; npm install"))

    venv = repo / "worker" / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    checks.append(_check("worker-venv", "Worker installed", "ok" if venv.exists() else "err",
                         "" if venv.exists() else "worker\\.venv is missing.",
                         "" if venv.exists() else "In worker\\: py -3.13 -m venv .venv, then .venv\\Scripts\\pip install -e ."))

    worker = status.get("worker") or {}
    if not worker.get("reachable"):
        checks.append(_check("worker", "Transcription worker running", "warn", f"Not answering at {worker.get('url', '')}.",
                             "Start it with .\\start-worker.ps1 (or .\\start.ps1, which starts both)."))
    elif worker.get("loadError"):
        checks.append(_check("worker", "Transcription worker running", "err", f"Its model failed to load: {worker['loadError']}",
                             "See the worker's window or data\\logs\\worker-*.log."))
    else:
        checks.append(_check("worker", "Transcription worker running", "ok", f"{worker.get('model', '')} on {worker.get('device', '')}"))

    if not val("DISCORD_TOKEN") or not val("DISCORD_CLIENT_ID"):
        checks.append(_check("discord-config", "Discord bot token and application ID", "err", "Missing in .env.",
                             "Fill in the Discord section below (from discord.com/developers)."))
    else:
        checks.append(_check("discord-config", "Discord bot token and application ID", "ok"))

    if not bot_online:
        checks.append(_check("bot", "Bot running", "warn", "The bot isn't answering.", "Start it with .\\start.ps1."))
    else:
        d = status.get("discord") or {}
        if d.get("ready"):
            guilds = d.get("guilds") or 0
            checks.append(_check("bot", "Bot running and in Discord", "ok" if guilds else "warn",
                                 f"Logged in as {d.get('tag')}, in {guilds} server(s).",
                                 "" if guilds else "Invite the bot to your server (OAuth2 → URL generator: bot + applications.commands)."))
        else:
            checks.append(_check("bot", "Bot running and in Discord", "warn", "The bot is running but not logged in to Discord.",
                                 "Check the Discord token; the bot's log says why."))

    token = values.get("API_TOKEN") or {}
    if token.get("isDefault", True):
        checks.append(_check("api-token", "API token set", "err", "Still the example value.",
                             "Generate one under Foundry below and paste it into the Foundry module's settings."))
    else:
        checks.append(_check("api-token", "API token set", "ok"))

    foundry = status.get("foundry") or {}
    headless = foundry.get("headless") or {}
    if not bot_online:
        checks.append(_check("foundry", "Foundry module connected", "skip", "Needs the bot."))
    elif foundry.get("sockets"):
        checks.append(_check("foundry", "Foundry module connected", "ok", f"World {foundry.get('lastRosterWorld') or '?'}"))
    elif headless.get("state") == "retrying":
        checks.append(_check("foundry", "Foundry module connected", "err", f"The headless client can't join: {headless.get('error')}",
                             "Check the Foundry settings below."))
    else:
        checks.append(_check("foundry", "Foundry module connected", "warn", "No Foundry client is connected right now.",
                             "Open your world as the GM (or the Bridge user) with ScribBot Bridge enabled and the same API token, "
                             "or turn on the headless client below."))

    llm = status.get("llm") or {}
    if llm.get("credentials"):
        checks.append(_check("llm", "Summaries (LLM) set up", "ok", f"{llm.get('provider')} / {llm.get('model') or 'default model'}"))
    else:
        state = "warn" if llm.get("autoSummarize") else "skip"
        checks.append(_check("llm", "Summaries (LLM) set up", state,
                             "No credentials found." + ("" if llm.get("autoSummarize") else " Only needed if you want summaries."),
                             "Fill in the Summaries section below."))

    campaign = Path(val("CAMPAIGN_DIR") or "./campaign")
    campaign = campaign if campaign.is_absolute() else repo / campaign
    have = [n for n in ("glossary.md", "context.md") if (campaign / n).exists()]
    checks.append(_check("campaign", "Campaign glossary and context", "ok" if len(have) == 2 else "warn",
                         f"{len(have)} of 2 files in {campaign}",
                         "" if len(have) == 2 else "The bot creates them from the templates on its first start; fill in names and lore."))

    disk = status.get("disk") or {}
    free = disk.get("freeBytes")
    if free is not None:
        gb = free / 1024**3
        checks.append(_check("disk", "Disk space", "ok" if gb >= 1 else "warn", f"{gb:.1f} GB free"))
    return checks
