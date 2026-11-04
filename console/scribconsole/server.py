"""The ScribBot Console: one local page with Sessions, Campaign, Monitoring and Configuration tabs.

    python -m scribconsole            # serves http://127.0.0.1:7422/ and opens your browser
    python -m scribconsole --no-browser --port 7500 --no-log-file

Standard library only, so it runs with any Python 3.10+ before anything else is installed. It
listens on 127.0.0.1 only. The browser talks to the Console and never to the bot: the Console
calls the bot's /admin API with API_TOKEN from .env, which never reaches the page.

The bot and worker don't depend on it: closing the Console (or the browser) stops nothing.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import threading
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .botlink import SLOW_TIMEOUT_S, BotLink, BotUnreachable, admin_path, worker_call
from .envfile import EnvFile, EnvValueError
from .monitoring import REPO_ROOT, SAFE_FOLDER, Config, LogFile, Monitor, log
from .settings import Settings, SettingsError, restart_needed_by
from .setup_checks import NodeVersion, run_checks

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".svg": "image/svg+xml"}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}
MAX_BODY = 2 * 1024 * 1024
CAMPAIGN_FILES = {"glossary": "glossary.md", "context": "context.md"}
# Changes to these need the Console itself restarted; every other Console setting applies on save.
CONSOLE_RESTART_KEYS = {"CONSOLE_PORT", "MONITOR_LOG_DIR"}
# Bot actions that join voice or wait for a model get a longer timeout.
SLOW_ADMIN = ("/admin/sessions", "/admin/llm/test")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def is_local_host_header(host: str | None) -> bool:
    """Rejects requests addressed to other host names (DNS rebinding)."""
    if not host:
        return False
    name = host.rsplit(":", 1)[0] if not host.endswith("]") else host
    return name.lower() in LOCAL_HOSTS


class Console:
    """Everything the handler needs; one per process."""

    def __init__(self, cfg: Config, logfile: LogFile, env_path: Path = REPO_ROOT / ".env", link: BotLink | None = None,
                 node: NodeVersion | None = None, worker_request=None):
        self.cfg = cfg
        self.link = link or BotLink(cfg.bot_url, cfg.api_token)
        self.monitor = Monitor(cfg, fetch=self.link.fetch, logfile=logfile)
        self.env = EnvFile(env_path, REPO_ROOT / ".env.example")
        self.settings = Settings(self.env)
        self.node = node or NodeVersion()
        self.worker_request = worker_request
        self.audit = logfile
        self._save_lock = threading.Lock()
        # process -> {"since": iso time of the save, "keys": [...]}: settings saved but not yet applied
        self.pending: dict[str, dict[str, Any]] = {}
        self._worker_seen_down = False

    # ---- status, shared by every tab

    def status(self) -> dict[str, Any]:
        data = self.monitor.status()
        self._settle_pending(data)
        data["console"] = {"pendingRestart": self.pending}
        return data

    def _settle_pending(self, status: dict[str, Any]) -> None:
        bot = self.pending.get("bot")
        started = (status.get("process") or {}).get("startedAt")
        if bot and started and started > bot["since"]:
            del self.pending["bot"]
        worker = self.pending.get("worker")
        reachable = bool((status.get("worker") or {}).get("reachable"))
        if worker:
            if not reachable:
                self._worker_seen_down = True
            elif self._worker_seen_down:
                del self.pending["worker"]
                self._worker_seen_down = False

    def reload_config(self) -> None:
        cfg = Config.load(self.env.path)
        self.cfg = cfg
        self.monitor.cfg = cfg
        self.link.remember(cfg.bot_url, cfg.api_token)

    # ---- sessions while the bot is down: the database, read-only

    def offline_sessions(self, deleted: str) -> list[dict[str, Any]]:
        db = self.cfg.data_dir / "scribbot.db"
        if not db.exists():
            return []
        try:
            conn = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=1)
        except sqlite3.Error:
            return []
        try:
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute("SELECT * FROM sessions ORDER BY started_at DESC LIMIT 200").fetchall()]
            try:
                campaigns = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM campaigns").fetchall()}
            except sqlite3.Error:
                campaigns = {}  # a database from before the campaign layout
        except sqlite3.Error as err:
            log(f"couldn't read {db}: {err}")
            return []
        finally:
            conn.close()
        want = {"only": lambda r: bool(r.get("deleted_at")), "include": lambda r: True}.get(deleted, lambda r: not r.get("deleted_at"))
        out = []
        for r in rows:
            if not want(r) or r.get("merged_into_id"):
                continue
            folder = self.monitor.game_folder(r["id"])
            error = r.get("error") or ""
            merged = error.startswith("Merged into session ")
            camp = campaigns.get(r.get("campaign_id"))
            out.append({
                "id": r["id"], "guildId": r["guild_id"], "number": r["number"], "title": r.get("title"), "notes": r.get("notes"),
                "campaignId": r.get("campaign_id"), "campaignFolder": camp["folder"] if camp else None,
                "campaign": (camp.get("alias") or camp.get("title") or camp["folder"]) if camp else None,
                "legacyLayout": not r.get("dir"), "recordings": 1,
                "status": r["status"], "error": r.get("error"), "startedAt": r["started_at"], "endedAt": r.get("ended_at"),
                "summarizedAt": r.get("summarized_at"), "audioPurged": bool(r.get("audio_purged")),
                "deletedAt": r.get("deleted_at"), "purgedAt": r.get("purged_at"),
                "summarySentAt": r.get("summary_sent_at"), "storySentAt": r.get("story_sent_at"),
                "summaryJournalAt": r.get("summary_journal_at"), "summaryJournalName": r.get("summary_journal_name"),
                "storyJournalAt": r.get("story_journal_at"), "storyJournalName": r.get("story_journal_name"),
                "textChannelId": r.get("text_channel_id"),
                "mergedInto": int(error.split()[-1]) if merged and error.split()[-1].isdigit() else None,
                "recording": False, "processing": False, "progress": None,
                "hasTranscript": (folder / "transcript.json").exists(), "hasChatlog": (folder / "chatlog.json").exists(),
                "hasSummary": (folder / "summary.json").exists(), "hasStory": (folder / "story" / "summary.story.md").exists(),
            })
        return out

    def offline_campaigns(self) -> dict[str, Any]:
        """The campaigns from the database, read-only, while the bot is down (never the Foundry password)."""
        db = self.cfg.data_dir / "scribbot.db"
        out: dict[str, Any] = {"campaigns": [], "chosenId": None, "rosterWorld": None, "foundryDefaults": None, "readOnly": True}
        if not db.exists():
            return out
        try:
            conn = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=1)
        except sqlite3.Error:
            return out
        try:
            conn.row_factory = sqlite3.Row
            cols = {r[1] for r in conn.execute("pragma table_info(campaigns)")}
            if not cols:
                return out
            rows = [dict(r) for r in conn.execute("SELECT * FROM campaigns ORDER BY last_seen_at IS NULL, last_seen_at DESC, id")]
            counts = dict(conn.execute(
                "SELECT campaign_id, COUNT(*) FROM sessions WHERE merged_into_id IS NULL AND deleted_at IS NULL GROUP BY campaign_id").fetchall())
        except sqlite3.Error as err:
            log(f"couldn't read campaigns from {db}: {err}")
            return out
        finally:
            conn.close()
        chosen = max((r for r in rows if r.get("selected_at")), key=lambda r: r["selected_at"], default=None)
        out["chosenId"] = chosen["id"] if chosen else None
        # Without a choice, the world Foundry synced last is where new recordings go (the bot's defaultCampaign()).
        default = chosen or next((r for r in rows if r.get("world_id") and r.get("last_seen_at")), None)
        for r in rows:
            out["campaigns"].append({
                "id": r["id"], "worldId": r.get("world_id"), "folder": r["folder"], "title": r.get("title"), "alias": r.get("alias"),
                "name": r.get("alias") or r.get("title") or r["folder"], "lastSeenAt": r.get("last_seen_at"),
                "isDefault": default is not None and default["id"] == r["id"], "chosen": chosen is not None and chosen["id"] == r["id"],
                "unassigned": r["folder"] == "_unassigned", "sessions": counts.get(r["id"], 0),
                "folderPath": str(self.cfg.data_dir / "campaigns" / r["folder"]),
                "foundry": {"url": r.get("foundry_url"), "user": r.get("foundry_user"), "passwordSet": bool(r.get("foundry_password"))},
            })
        return out

    # ---- configuration

    def save_settings(self, changes: dict[str, Any], version: str | None) -> dict[str, Any]:
        with self._save_lock:
            result = self.settings.save(changes, version)
            if result.changed:
                self.audit.event(f"settings saved: {', '.join(result.changed)}")  # names only, never values
                since = _now_iso()
                for proc in result.restart:
                    keys = [k for k in result.changed if proc in restart_needed_by(self.settings.by_key[k])]
                    if proc == "console":
                        keys = [k for k in keys if k in CONSOLE_RESTART_KEYS]
                        if not keys:
                            continue
                    entry = self.pending.setdefault(proc, {"since": since, "keys": []})
                    entry["since"] = since
                    entry["keys"] = sorted(set(entry["keys"]) | set(keys))
                if "worker" in self.pending:
                    self._worker_seen_down = False
                self.reload_config()
            return {"ok": True, "changed": result.changed, "warnings": result.warnings, "pendingRestart": self.pending,
                    "version": self.env.version()}

    def setup(self) -> dict[str, Any]:
        view = self.settings.view()
        return {"checks": run_checks(REPO_ROOT, view["values"], self.status(), self.node, view["envExists"])}

    # ---- worker

    def worker(self, action: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if action == "restart":
            shutdown = ((self.status().get("monitor") or {}).get("pipeline") or {}).get("shutdown") or {}
            if shutdown.get("state") == "no":
                return 409, {"ok": False, "error": "A session is recording. Restart the worker after it stops."}
            if shutdown.get("state") == "wait" and not body.get("force"):
                return 409, {"ok": False, "needsConfirm": True,
                             "error": "The worker is busy: " + " ".join(shutdown.get("reasons") or []) +
                                      " Restarting drops its queue; it re-queues the clips from disk when it starts."}
        reason = str(body.get("reason") or "from the Console")[:200]
        kwargs = {"request": self.worker_request} if self.worker_request else {}
        reply = worker_call(self.cfg.worker_url, "POST", f"/{action}", {"reason": reason}, **kwargs)
        if reply.status < 400:
            self.audit.event(f"worker {action} ({reason})")
        return reply.status, reply.body if isinstance(reply.body, dict) else {"ok": reply.status < 400}

    # ---- campaign notes: CAMPAIGN_DIR/<campaign folder>/<file> (the Campaign tab), or the shared CAMPAIGN_DIR/<file>

    def campaign_file(self, name: str, folder: str | None = None) -> Path | None:
        file = CAMPAIGN_FILES.get(name)
        if not file or (folder is not None and not SAFE_FOLDER.fullmatch(folder)):
            return None
        return self.cfg.campaign_dir / folder / file if folder else self.cfg.campaign_dir / file

    def read_campaign_file(self, name: str, folder: str | None) -> dict[str, Any] | None:
        """A campaign's note, or the shared one it still uses (inherited) until the campaign saves its own."""
        file = self.campaign_file(name, folder)
        if not file:
            return None
        shared = self.campaign_file(name)
        if file.exists() or not folder:
            return {"path": str(file), "exists": file.exists(), "inherited": False, "text": file.read_text("utf-8") if file.exists() else ""}
        return {"path": str(file), "exists": False, "inherited": shared.exists(), "sharedPath": str(shared),
                "text": shared.read_text("utf-8") if shared.exists() else ""}


def make_handler(console: Console) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "ScribConsole"

        # ---------------------------------------------------------------- GET

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if not is_local_host_header(self.headers.get("Host")):
                return self._send(403, b"forbidden", "text/plain")
            url = urlsplit(self.path)
            path = url.path
            try:
                if path in ("/", "/index.html", "/dashboard"):
                    return self._static("index.html")
                if path.startswith("/static/"):
                    return self._static(path[len("/static/"):])
                if path == "/status":
                    return self._json(200, console.status())
                if path == "/health":
                    return self._json(200, {"ok": True, "name": "scribconsole"})
                if path == "/monitor/recent-log":
                    lf = console.monitor.logfile
                    return self._json(200, {"enabled": lf.folder is not None, "folder": str(lf.folder or ""), "lines": lf.tail(40)})
                if path == "/api/logs":
                    after = parse_qs(url.query).get("after", ["0"])[0]
                    try:
                        reply = console.link.call("GET", f"/logs?after={int(after)}")
                    except (BotUnreachable, ValueError):
                        return self._json(200, {"online": False, "entries": []})
                    return self._json(200, {"online": reply.status == 200, "entries": reply.body if reply.status == 200 else []})
                if path == "/api/config":
                    return self._json(200, {**console.settings.view(), "pendingRestart": console.pending})
                if path == "/api/setup":
                    return self._json(200, console.setup())
                if path.startswith("/api/campaign/"):
                    folder = parse_qs(url.query).get("campaign", [None])[0]
                    note = console.read_campaign_file(path.rsplit("/", 1)[1], folder)
                    if not note:
                        return self._json(404, {"ok": False, "error": "no such file"})
                    return self._json(200, note)
                if path.startswith("/api/admin/"):
                    return self._admin("GET", path[len("/api/admin/"):], url.query, None)
                return self._send(404, b"not found", "text/plain")
            except Exception as err:  # noqa: BLE001 - one bad request must not take the Console down
                log(f"GET {path} failed: {err}")
                return self._json(500, {"ok": False, "error": str(err)})

        # ---------------------------------------------------------------- changes

        def do_POST(self) -> None:  # noqa: N802
            self._change("POST")

        def do_PUT(self) -> None:  # noqa: N802
            self._change("PUT")

        def do_PATCH(self) -> None:  # noqa: N802
            self._change("PATCH")

        def do_DELETE(self) -> None:  # noqa: N802
            self._change("DELETE")

        def _change(self, method: str) -> None:
            if not is_local_host_header(self.headers.get("Host")):
                return self._send(403, b"forbidden", "text/plain")
            refused = self._csrf_problem()
            if refused:
                return self._json(403, {"ok": False, "error": refused})
            try:
                body = self._body()
            except ValueError as err:
                return self._json(400, {"ok": False, "error": str(err)})
            url = urlsplit(self.path)
            path = url.path
            try:
                if path.startswith("/api/admin/"):
                    return self._admin(method, path[len("/api/admin/"):], url.query, body)
                if path == "/api/config" and method == "POST":
                    if not isinstance(body, dict) or not isinstance(body.get("changes"), dict):
                        return self._json(400, {"ok": False, "error": "expected {changes: {...}}"})
                    try:
                        return self._json(200, console.save_settings(body["changes"], body.get("version")))
                    except SettingsError as err:
                        return self._json(400, {"ok": False, "error": "Some values aren't valid.", "problems": err.problems})
                    except EnvValueError as err:
                        return self._json(409, {"ok": False, "error": str(err)})
                if path == "/api/config/create-env" and method == "POST":
                    try:
                        console.env.create_from_example()
                    except EnvValueError as err:
                        return self._json(409, {"ok": False, "error": str(err)})
                    console.audit.event(".env created from .env.example")
                    console.reload_config()
                    return self._json(200, {"ok": True})
                if path.startswith("/api/worker/") and method == "POST":
                    action = path.rsplit("/", 1)[1]
                    if action not in ("pause", "resume", "restart"):
                        return self._json(404, {"ok": False, "error": "unknown action"})
                    try:
                        code, reply = console.worker(action, body if isinstance(body, dict) else {})
                    except BotUnreachable as err:
                        return self._json(502, {"ok": False, "error": f"The worker isn't answering ({err.reason})."})
                    return self._json(code, reply)
                if path.startswith("/api/campaign/") and method == "PUT":
                    file = console.campaign_file(path.rsplit("/", 1)[1], parse_qs(url.query).get("campaign", [None])[0])
                    if not file or not isinstance(body, dict) or not isinstance(body.get("text"), str):
                        return self._json(400, {"ok": False, "error": "expected {text}"})
                    file.parent.mkdir(parents=True, exist_ok=True)
                    tmp = file.with_name(file.name + ".tmp")
                    tmp.write_text(body["text"], encoding="utf-8")
                    tmp.replace(file)
                    console.audit.event(f"campaign file saved: {file.relative_to(console.cfg.campaign_dir)}")
                    return self._json(200, {"ok": True})
                return self._json(404, {"ok": False, "error": "not found"})
            except Exception as err:  # noqa: BLE001
                log(f"{method} {path} failed: {err}")
                return self._json(500, {"ok": False, "error": str(err)})

        # ---------------------------------------------------------------- the bot's /admin API

        def _admin(self, method: str, rest: str, query: str, body: Any) -> None:
            target = admin_path(rest, query)
            if not target:
                return self._json(400, {"ok": False, "error": "bad path"})
            # Listing a CLI's models starts that CLI, which can take a while.
            slow = (method != "GET" and target.startswith(SLOW_ADMIN)) or target.startswith("/admin/llm/models")
            listing = method == "GET" and target.split("?")[0] in ("/admin/sessions", "/admin/campaigns")
            try:
                # The sampler already knows the bot is down: on Windows a refused connection takes ~2 s.
                if listing and console.monitor.bot_online is False:
                    raise BotUnreachable("the bot is offline")
                reply = console.link.call(method, target, body, timeout=SLOW_TIMEOUT_S if slow else 10)
            except BotUnreachable as err:
                if listing and target.startswith("/admin/campaigns"):
                    return self._json(200, console.offline_campaigns())
                if listing:
                    deleted = parse_qs(query).get("deleted", ["exclude"])[0]
                    return self._json(200, {"sessions": console.offline_sessions(deleted), "readOnly": True})
                return self._json(503, {"ok": False, "offline": True,
                                        "error": f"The bot isn't running ({err.reason}). Start it with .\\start.ps1; "
                                                 "until then sessions are read-only."})
            if method != "GET" and reply.status < 400:
                console.audit.event(f"{method} {target}")
            payload = reply.body if reply.body is not None else {"ok": reply.status < 400}
            if reply.status == 401:
                payload = {"ok": False, "error": "The bot rejected the API token in .env. If you just changed it, restart the bot."}
            return self._json(reply.status, payload)

        # ---------------------------------------------------------------- plumbing

        def _csrf_problem(self) -> str | None:
            """A cross-site page can't send this header without a CORS preflight, which is never answered."""
            if self.headers.get("X-Scrib-Console") != "1":
                return "missing X-Scrib-Console header"
            if self.headers.get("Sec-Fetch-Site") in ("cross-site", "same-site"):
                return "cross-site request"
            origin = self.headers.get("Origin")
            if origin:
                host = urlsplit(origin).hostname or ""
                if host.lower() not in LOCAL_HOSTS and f"[{host}]" not in LOCAL_HOSTS:
                    return "foreign origin"
                if urlsplit(origin).port != self.server.server_address[1]:
                    return "foreign origin"
            if int(self.headers.get("Content-Length") or 0) and not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return "body must be JSON"
            return None

        def _body(self) -> Any:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise ValueError("body too large")
            if not length:
                return None
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as err:
                raise ValueError(f"bad JSON: {err}") from err

        def _static(self, name: str) -> None:
            if "/" in name or "\\" in name or name.startswith("."):
                return self._send(404, b"not found", "text/plain")
            file = STATIC_DIR / name
            kind = STATIC_TYPES.get(file.suffix)
            if not kind or not file.is_file():
                return self._send(404, b"not found", "text/plain")
            self._send(200, file.read_bytes(), kind)

        def _json(self, code: int, data: Any) -> None:
            self._send(code, json.dumps(data).encode("utf-8"), "application/json")

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - keep the console quiet
            pass

    return Handler


class ConsoleServer(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second process bind a port that's already in use, so two Consoles
    # would silently share 7422 and answer requests at random. Elsewhere it only skips TIME_WAIT.
    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True


def main(argv: list[str] | None = None) -> int:
    cfg = Config.load()
    parser = argparse.ArgumentParser(description="The ScribBot Console: sessions, monitoring and settings.")
    parser.add_argument("--port", type=int, default=cfg.port, help=f"port to serve on (default {cfg.port}, CONSOLE_PORT in .env)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the page in a browser")
    parser.add_argument("--no-log-file", action="store_true", help=f"don't copy the bot's log to {cfg.log_dir}")
    args = parser.parse_args(argv)

    console = Console(cfg, LogFile(None if args.no_log_file else cfg.log_dir))
    try:
        server = ConsoleServer(("127.0.0.1", args.port), make_handler(console))
    except OSError as err:
        log(f"can't listen on 127.0.0.1:{args.port}: {err}. Is the Console already running? Use --port to pick another.")
        return 1
    stop = threading.Event()
    threading.Thread(target=console.monitor.run_sampler, args=(stop,), daemon=True, name="sampler").start()

    url = f"http://127.0.0.1:{args.port}/"
    where = "off" if args.no_log_file else str(cfg.log_dir)
    log(f"serving {url} (bot {cfg.bot_url}, worker {cfg.worker_url}, log copy {where}). Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
