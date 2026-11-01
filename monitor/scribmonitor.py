"""ScribBot watchdog: an optional, read-only helper for when the bot itself is down.

Run it with any Python 3.10+ (standard library only, nothing to install):

    python monitor/scribmonitor.py            # serves http://127.0.0.1:7422/ and opens your browser
    python monitor/scribmonitor.py --no-browser --port 7500 --no-log-file

The bot's dashboard (http://127.0.0.1:7420) is the one page to watch; it has the transcription
pipeline panel too (docs/assessment/05 C1). This watchdog only covers what needs a separate process:
  - While the bot is running, http://127.0.0.1:7422/ redirects to the bot's dashboard.
  - While the bot is down, it serves a small fallback page: a crash notice if it went down
    mid-recording, the worker's queue, whether it's safe to shut down, and the bot's last log lines.
    It reads the worker's health, sessions from the database (read-only) and disk space by itself.
  - A background sampler (every 5 s, page open or not) notices the bot disappearing mid-recording
    and copies the bot's log to data/logs/scribbot-*.log. The API_TOKEN from .env stays inside this
    process; the browser never sees it.

Neither the bot nor the worker knows about this program. Starting or stopping it has no
effect on recording, transcription or summaries. It never writes outside its own log folder,
and it never opens timeline.json while the bot is recording into it (the bot replaces that
file by renaming over it, which fails on Windows while another process holds it open).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
import webbrowser
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

MONITOR_DIR = Path(__file__).resolve().parent
REPO_ROOT = MONITOR_DIR.parent
OFFLINE_PAGE = MONITOR_DIR / "offline.html"  # shown while the bot is down
DEFAULT_MODELS = {"anthropic": "claude-opus-5-5", "xai": "grok-4"}
REQUEST_TIMEOUT_S = 3
SESSION_LIMIT = 20  # same as the bot's /status
LOW_DISK_BYTES = 1024**3
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}
ACTIVE_STATUSES = {"recording", "transcribing", "summarizing"}
CACHE_NAME = "transcript.partial.jsonl"  # the worker's per-clip results (worker/scribworker/transcribe.py)

STATUS_TTL_S = 1.5  # the page, the panel and the sampler share one bot /status call
SAMPLE_INTERVAL_S = 5
RATE_WINDOW_S = 300  # throughput and queue trend are measured over the last 5 minutes
MIN_RATE_SPAN_S = 20  # ...once at least this much history exists
STALL_AFTER_S = 120  # queue not empty and nothing converted for this long → worker looks stuck
# A failed session whose worker cache changed this recently is still shown: the worker re-queues
# untranscribed clips from disk when it restarts, so it may be converting while the bot says "failed".
FAILED_RECENT_S = 12 * 3600
SILENT_AFTER_S = 180  # recording, but no new clip for this long → voice connection may be lost
BEHIND_TREND_PER_MIN = 1.0  # queue growing faster than this while recording → falling behind
LOG_RETENTION_DAYS = 14

# Mirrors the worker's is_noise() (MIN_MEAN_PROBABILITY) and the bot's keyword cap (campaign.ts).
NOISE_PROBABILITY = 0.35
MAX_HOTWORDS = 150
MAX_ACTOR_NAMES = 300
# What Whisper typically writes for silence; seen in real sessions.
STOCK_HALLUCINATIONS = {
    "thank you", "thank you for watching", "thanks for watching", "the end", "you",
    "please subscribe", "subtitles by the amara.org community", "bye",
}


def log(msg: str) -> None:
    print(f"[monitor] {msg}", flush=True)


# ---------------------------------------------------------------- configuration


def parse_env_file(path: Path) -> dict[str, str]:
    """Minimal .env reader (KEY=value, # comments, optional quotes). Missing file → {}."""
    env: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return env
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        env[key] = value
    return env


def _bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _number(value: str | None, default: float) -> float:
    try:
        return float(value) if value not in (None, "") else default
    except ValueError:
        return default


def _resolve(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else (REPO_ROOT / path).resolve()


@dataclass(frozen=True)
class Config:
    bot_url: str
    api_token: str
    worker_url: str
    data_dir: Path
    llm_provider: str
    llm_model: str | None
    llm_credentials: str | None  # a credential *source* (e.g. "api key"), never the value
    chunk_minutes: float
    auto_summarize: bool
    delete_audio: bool
    retention_days: float
    port: int
    campaign_dir: Path = field(default=REPO_ROOT / "campaign")
    log_dir: Path | None = None  # None: don't keep log files

    @classmethod
    def load(cls, env_file: Path = REPO_ROOT / ".env", environ: dict[str, str] | None = None) -> "Config":
        # Like the bot (dotenv), real environment variables win over .env.
        env = {**parse_env_file(env_file), **(os.environ if environ is None else environ)}
        get = lambda k, d="": (env.get(k) or d).strip()  # noqa: E731

        host = get("API_HOST", "127.0.0.1")
        if host in {"0.0.0.0", "::", ""}:
            host = "127.0.0.1"
        provider = get("LLM_PROVIDER", "anthropic")
        if provider == "anthropic":
            creds = "api key" if get("ANTHROPIC_API_KEY") else "auth token" if get("ANTHROPIC_AUTH_TOKEN") else None
        elif provider == "xai":
            creds = "api key" if get("XAI_API_KEY") else None
        else:
            creds = "api key" if get("OPENAI_API_KEY") else ("none needed" if get("OPENAI_BASE_URL") else None)
        data_dir = _resolve(get("DATA_DIR", "./data"))
        return cls(
            bot_url=f"http://{host}:{int(_number(get('API_PORT'), 7420))}",
            api_token=get("API_TOKEN", "change-me"),
            worker_url=get("WORKER_URL", "http://127.0.0.1:7421").rstrip("/"),
            data_dir=data_dir,
            llm_provider=provider,
            llm_model=get("LLM_MODEL") or DEFAULT_MODELS.get(provider),
            llm_credentials=creds,
            chunk_minutes=_number(get("SUMMARY_CHUNK_MINUTES"), 25),
            auto_summarize=_bool(env.get("AUTO_SUMMARIZE"), False),
            delete_audio=_bool(env.get("DELETE_AUDIO_AFTER_TRANSCRIBE"), True),
            retention_days=_number(get("AUDIO_RETENTION_DAYS"), 14),
            port=int(_number(get("MONITOR_PORT"), 7422)),
            campaign_dir=_resolve(get("CAMPAIGN_DIR", "./campaign")),
            log_dir=_resolve(get("MONITOR_LOG_DIR")) if get("MONITOR_LOG_DIR") else data_dir / "logs",
        )


# ---------------------------------------------------------------- helpers


def fetch_json(url: str, token: str | None = None, timeout: float = REQUEST_TIMEOUT_S) -> Any:
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    with urlopen(Request(url, headers=headers), timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _dur(sec: float) -> str:
    sec = max(0, round(sec))
    h, m = divmod(sec // 60, 60)
    return f"{h}h {m:02d}m" if h else f"{m}m" if m else f"{sec}s"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


_WORD = re.compile(r"[\w']+")


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text)]


def glossary_names(text: str) -> list[str]:
    """Same rule as the bot's glossaryNames(): each list item or line, up to any ':' note."""
    text = re.sub(r"<!--[\s\S]*?-->", "", text)
    names = []
    for line in text.splitlines():
        if line.strip().startswith("#"):
            continue
        name = re.sub(r"^\s*[-*]\s*", "", line).split(":")[0].strip()
        if name and len(name) <= 40:
            names.append(name)
    return names


@dataclass
class ClipText:
    file: str
    text: str  # every segment joined
    noise: bool  # every segment would be dropped by the worker's is_noise()


def parse_cache(path: Path) -> list[ClipText]:
    """The worker's per-clip cache, one entry per clip (a retried clip counts once)."""
    clips: dict[str, ClipText] = {}
    for raw in path.read_text("utf-8").splitlines():
        try:
            entry = json.loads(raw)
            file = entry["file"]
            segs = entry.get("segments") or []
        except (ValueError, KeyError, TypeError):
            continue  # blank or torn last line
        kept = [
            s for s in segs
            if str(s.get("text", "")).strip()
            and any(c.isalnum() for c in str(s.get("text", "")))
            and float(s.get("probability", 1.0)) >= NOISE_PROBABILITY
        ]
        clips[file] = ClipText(file, " ".join(str(s.get("text", "")).strip() for s in segs).strip(), not kept)
    return list(clips.values())


SEGMENT_JOURNAL = "timeline.segments.jsonl"  # the bot appends each clip here; timeline.json is a snapshot


def count_segments(folder: Path) -> int:
    """Clips in timeline.json plus any only the bot's segment journal lists (by file)."""
    segments = json.loads((folder / "timeline.json").read_text("utf-8")).get("segments", [])
    known = {s.get("file") for s in segments}
    extra: set[str] = set()
    try:
        for raw in (folder / SEGMENT_JOURNAL).read_text("utf-8").splitlines():
            try:
                f = json.loads(raw).get("file")
            except ValueError:
                continue  # a torn last line
            if f and f not in known:
                extra.add(f)
    except OSError:
        pass
    return len(segments) + len(extra)


def is_hallucination(text: str, hotword_words: set[str]) -> bool:
    """Stock silence phrases, or text made (almost) only of hotwords: Whisper echoing its prompt."""
    words = _words(text)
    if not words:
        return False
    if " ".join(words) in STOCK_HALLUCINATIONS:
        return True
    if not hotword_words:
        return False
    hits = sum(w in hotword_words for w in words)
    return hits / len(words) >= 0.8


# ---------------------------------------------------------------- log file


class LogFile:
    """Daily files in data/logs/: the bot's log (copied from /logs) and the monitor's own events."""

    def __init__(self, folder: Path | None, today: Callable[[], date] = date.today):
        self.folder = folder
        self.today = today
        self._lock = threading.Lock()

    def path_for(self, day: date) -> Path | None:
        return self.folder / f"scribbot-{day.isoformat()}.log" if self.folder else None

    def write(self, lines: list[str]) -> None:
        if not self.folder or not lines:
            return
        with self._lock:
            try:
                self.folder.mkdir(parents=True, exist_ok=True)
                with self.path_for(self.today()).open("a", encoding="utf-8") as out:
                    out.write("".join(line.rstrip("\n") + "\n" for line in lines))
            except OSError as err:
                log(f"can't write the log file in {self.folder}: {err}")

    def event(self, msg: str) -> None:
        self.write([f"{_iso_now()} MON   [monitor] {msg}"])

    def tail(self, n: int = 40) -> list[str]:
        if not self.folder:
            return []
        lines: list[str] = []
        for day in (self.today() - timedelta(days=1), self.today()):
            try:
                lines += self.path_for(day).read_text("utf-8").splitlines()
            except OSError:
                pass
        return lines[-n:]

    def prune(self, keep_days: int = LOG_RETENTION_DAYS) -> None:
        if not self.folder or not self.folder.exists():
            return
        cutoff = self.today() - timedelta(days=keep_days)
        for f in self.folder.glob("scribbot-*.log"):
            try:
                if date.fromisoformat(f.stem.removeprefix("scribbot-")) < cutoff:
                    f.unlink()
            except (ValueError, OSError):
                continue

    # Which bot log lines are already in the file, across monitor restarts.
    def load_state(self) -> dict[str, Any]:
        try:
            return json.loads((self.folder / "monitor-state.json").read_text("utf-8")) if self.folder else {}
        except (OSError, ValueError):
            return {}

    def save_state(self, state: dict[str, Any]) -> None:
        if not self.folder:
            return
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            tmp = self.folder / "monitor-state.json.tmp"
            tmp.write_text(json.dumps(state), "utf-8")
            os.replace(tmp, self.folder / "monitor-state.json")
        except OSError as err:
            log(f"can't save {self.folder / 'monitor-state.json'}: {err}")


# ---------------------------------------------------------------- monitor


class Monitor:
    def __init__(
        self,
        cfg: Config,
        fetch: Callable[..., Any] = fetch_json,
        clock: Callable[[], float] = time.monotonic,
        logfile: LogFile | None = None,
    ):
        self.cfg = cfg
        self.fetch = fetch
        self.clock = clock
        self.logfile = logfile or LogFile(None)
        self._bot_online: bool | None = None
        self._status_lock = threading.Lock()
        self._cached: tuple[float, dict[str, Any]] | None = None
        # (time, {session id: clips converted}, queue depth, worker live done, worker live failed), newest last
        self._samples: deque[tuple[float, dict[str, int], int | None, int, int]] = deque()
        self._file_memo: dict[Path, tuple[tuple[int, int], Any]] = {}
        self._clip_seen: dict[str, tuple[int, float]] = {}  # recording session → (clips, when that count changed)
        self._progress_seen: tuple[int, float] | None = None  # (total converted, when it last grew)
        self._last_recordings: list[dict[str, Any]] = []  # what was recording at the last online poll
        self._last_online_at: str | None = None
        self._crash: dict[str, Any] | None = None  # the bot went away mid-recording
        self._raised: set[str] = set()  # alert keys already written to the log file
        self._log_state = self.logfile.load_state()

    # ---- what the page polls

    def status(self) -> dict[str, Any]:
        """The bot's /status (or an offline stand-in) plus monitor.pipeline. Shared for STATUS_TTL_S."""
        with self._status_lock:
            now = self.clock()
            if self._cached and now - self._cached[0] < STATUS_TTL_S:
                return self._cached[1]
            data = self._fresh_status()
            self._cached = (now, data)
            return data

    def _fresh_status(self) -> dict[str, Any]:
        try:
            data = self.fetch(f"{self.cfg.bot_url}/status", self.cfg.api_token)
            self._note_bot(True)
            data["monitor"] = {"bot": "online", "botUrl": self.cfg.bot_url}
        except HTTPError as err:
            reason = "it rejected the API_TOKEN from .env" if err.code == 401 else f"HTTP {err.code}"
            data = None
        except (URLError, OSError, ValueError) as err:
            reason = getattr(err, "reason", None) or str(err)
            data = None
        if data is None:
            self._note_bot(False, str(reason))
            data = self.offline_status(str(reason))
        pipeline = self.pipeline(data)
        data["monitor"]["pipeline"] = pipeline
        known = set(data.get("warnings") or [])
        data["warnings"] = [a["text"] for a in pipeline["alerts"] if a["text"] not in known] + list(data.get("warnings") or [])
        return data

    def _note_bot(self, online: bool, reason: str = "") -> None:
        if online != self._bot_online:
            msg = f"bot at {self.cfg.bot_url} is " + ("online" if online else f"offline ({reason})")
            log(msg)
            self.logfile.event(msg)
            self._bot_online = online

    # ---- background sampling: rate history, alerts and the log copy keep going with no page open

    def sample_once(self) -> None:
        data = self.status()
        if data["monitor"]["bot"] == "online":
            self.copy_bot_logs(data)

    def run_sampler(self, stop: threading.Event, interval: float = SAMPLE_INTERVAL_S) -> None:
        self.logfile.prune()
        last_prune = time.monotonic()
        while not stop.is_set():
            try:
                self.sample_once()
                if time.monotonic() - last_prune > 6 * 3600:
                    self.logfile.prune()
                    last_prune = time.monotonic()
            except Exception as err:  # noqa: BLE001 - the sampler must never die
                log(f"sampler error: {err}")
            stop.wait(interval)

    def copy_bot_logs(self, status: dict[str, Any]) -> None:
        """Append the bot's new /logs entries to today's file, once each, across restarts of either side."""
        if not self.logfile.folder:
            return
        started = (status.get("process") or {}).get("startedAt")
        if not started:
            return
        state = self._log_state
        if state.get("botStartedAt") != started:
            state = {"botStartedAt": started, "seq": 0}
            self.logfile.event(f"bot process started at {started}")
        try:
            entries = self.fetch(f"{self.cfg.bot_url}/logs?after={state['seq']}", self.cfg.api_token)
        except (URLError, OSError, ValueError):
            return
        if not entries:
            self._log_state = state
            return
        if entries[0]["seq"] > state["seq"] + 1:
            missed = entries[0]["seq"] - state["seq"] - 1
            self.logfile.event(f"{missed} earlier bot log line(s) weren't captured (the monitor wasn't running)")
        self.logfile.write([f"{e['t']} {str(e.get('level', 'info')).upper():<5} {e.get('msg', '')}" for e in entries])
        state = {"botStartedAt": started, "seq": entries[-1]["seq"]}
        self._log_state = state
        self.logfile.save_state(state)

    # ---- fallback when the bot is down (same shape as the bot's /status)

    def offline_status(self, reason: str) -> dict[str, Any]:
        cfg = self.cfg
        worker = self.worker_status()
        sessions, roster = self.read_database()
        disk = self.disk_status()

        warnings = [
            f"The ScribBot bot isn't answering at {cfg.bot_url} ({reason}). Start it with .\\start.ps1. "
            "Showing what the monitor can read on its own; Discord, recording and Foundry details need the bot."
        ]
        if not worker["reachable"]:
            warnings.append(f"Transcription worker is unreachable at {cfg.worker_url}. Start it with .\\start-worker.ps1.")
        elif worker.get("loadError"):
            warnings.append(f"The worker's speech-to-text model failed to load: {worker['loadError']}")
        if not cfg.auto_summarize:
            pass  # sessions end at a transcript; a missing LLM setup isn't a problem
        elif not cfg.llm_credentials and cfg.llm_provider == "anthropic":
            warnings.append("No ANTHROPIC_API_KEY in .env. That's fine if you used `ant auth login`; the bot checks that when it runs.")
        elif not cfg.llm_credentials:
            warnings.append(f"No credentials in .env for LLM provider '{cfg.llm_provider}'.")
        failed = [s for s in sessions if s["status"] == "failed"]
        if failed:
            warnings.append(f"{len(failed)} session(s) failed. Run /scrib process to resume.")
        if disk["freeBytes"] is not None and disk["freeBytes"] < LOW_DISK_BYTES:
            warnings.append("Less than 1 GB free in the data directory.")

        return {
            "now": _iso_now(),
            "process": {"startedAt": None, "uptimeSec": None, "rssBytes": None, "node": "bot offline"},
            "discord": None,
            "recordings": [],
            "worker": worker,
            "llm": {
                "provider": cfg.llm_provider,
                "model": cfg.llm_model,
                "credentials": cfg.llm_credentials,
                "credentialsError": None,
                "chunkMinutes": cfg.chunk_minutes,
                "autoSummarize": cfg.auto_summarize,
            },
            "foundry": {
                "sockets": 0,
                "lastRosterAt": None,
                "lastRosterWorld": None,
                "lastChatlogAt": None,
                "rosterUsers": roster[0],
                "rosterLinked": roster[1],
            },
            "config": {"deleteAudioAfterTranscribe": cfg.delete_audio, "audioRetentionDays": cfg.retention_days},
            "disk": disk,
            "sessions": sessions,
            "warnings": warnings,
            "monitor": {"bot": "offline", "botUrl": cfg.bot_url, "reason": reason},
        }

    def worker_status(self) -> dict[str, Any]:
        url = self.cfg.worker_url
        t0 = time.monotonic()
        try:
            health = self.fetch(f"{url}/health")
            return {"reachable": True, "latencyMs": round((time.monotonic() - t0) * 1000), "url": url, **health, "error": None}
        except Exception as err:  # noqa: BLE001 - any failure means "unreachable"
            return {"reachable": False, "latencyMs": None, "url": url, "error": str(getattr(err, "reason", err))}

    def disk_status(self) -> dict[str, Any]:
        path = self.cfg.data_dir
        try:
            usage = shutil.disk_usage(path if path.exists() else REPO_ROOT)
            return {"path": str(path), "freeBytes": usage.free, "totalBytes": usage.total}
        except OSError:
            return {"path": str(path), "freeBytes": None, "totalBytes": None}

    def read_database(self) -> tuple[list[dict[str, Any]], tuple[int, int]]:
        """Recent sessions and roster counts, opened read-only so the bot is never affected."""
        db = self.cfg.data_dir / "scribbot.db"
        if not db.exists():
            return [], (0, 0)
        try:
            conn = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=1)
        except sqlite3.Error:
            return [], (0, 0)
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?", (SESSION_LIMIT,)).fetchall()
            try:
                users, linked = conn.execute("SELECT COUNT(*), COUNT(discord_id) FROM roster").fetchone()
            except sqlite3.Error:
                users, linked = 0, 0
            return [self._session(dict(r)) for r in rows], (users, linked)
        except sqlite3.Error as err:
            log(f"couldn't read {db}: {err}")
            return [], (0, 0)
        finally:
            conn.close()

    def _session(self, row: dict[str, Any]) -> dict[str, Any]:
        # Only called while the bot is down, so reading timeline.json can't get in its way.
        folder = self.cfg.data_dir / "sessions" / row["id"]
        clips = speakers = None
        try:
            timeline = json.loads((folder / "timeline.json").read_text(encoding="utf-8"))
            clips = count_segments(folder)
            speakers = len(timeline.get("participants", []))
        except (OSError, ValueError):
            pass
        return {
            "id": row["id"],
            "number": row["number"],
            "status": row["status"],
            "error": row.get("error"),
            "startedAt": row["started_at"],
            "endedAt": row.get("ended_at"),
            "summarizedAt": row.get("summarized_at"),
            "audioPurged": bool(row.get("audio_purged")),
            "processing": False,
            "progress": None,
            "clips": clips,
            "speakers": speakers,
            "hasTranscript": (folder / "transcript.json").exists(),
            "hasChatlog": (folder / "chatlog.json").exists(),
            "hasSummary": (folder / "summary.json").exists(),
        }

    # ---- queue depth, conversion progress, quality, alerts, and whether it's safe to shut down

    def pipeline(self, status: dict[str, Any]) -> dict[str, Any]:
        bot_online = status.get("monitor", {}).get("bot") == "online"
        worker = status.get("worker") or {}
        queued = worker.get("queued") if worker.get("reachable") else None
        recordings = {r["sessionId"]: r for r in status.get("recordings") or []}
        sessions = [
            s for s in status.get("sessions") or []
            if s["id"] in recordings or s["status"] in ACTIVE_STATUSES or s.get("processing") or self._recent_failed(s)
        ]
        hotwords = self.hotwords([p.get("character") for r in recordings.values() for p in r.get("speakers") or []])
        conversions = [self.conversion(s, recordings.get(s["id"]), bot_online, hotwords) for s in sessions]
        queue = self._measure(conversions, queued, worker)
        self._track_crash(bot_online, list(recordings.values()), status.get("now"))
        alerts = self.alerts(status, bot_online, worker, list(recordings.values()), conversions, queue)
        return {
            "queue": queue,
            "conversions": conversions,
            "hotwords": {"count": len(hotwords["names"]), "fromFoundry": hotwords["fromFoundry"]},
            "alerts": alerts,
            "crash": self._crash,
            "shutdown": self.shutdown_advice(bot_online, worker, list(recordings.values()), conversions, queue),
        }

    def _recent_failed(self, session: dict[str, Any]) -> bool:
        """A failed session with no transcript.json yet whose worker cache changed recently (stat only, no open)."""
        if session.get("status") != "failed":
            return False
        folder = self.cfg.data_dir / "sessions" / session["id"]
        try:
            if (folder / "transcript.json").exists():
                return False
            return time.time() - (folder / CACHE_NAME).stat().st_mtime < FAILED_RECENT_S
        except OSError:
            return False

    def hotwords(self, party: list[str | None]) -> dict[str, Any]:
        """Roughly the keyword list the bot sends the worker with each clip (campaign.ts sttKeywords)."""
        glossary = self._read_memo(self.cfg.campaign_dir / "glossary.md", lambda p: glossary_names(p.read_text("utf-8")))
        actors = self._read_memo(
            self.cfg.data_dir / "foundry-actors.json",
            lambda p: list(dict.fromkeys(a["name"] for a in json.loads(p.read_text("utf-8")) if a.get("name")))[:MAX_ACTOR_NAMES],
        )
        names = list(dict.fromkeys([*(n for n in party if n), *(glossary or []), *(actors or [])]))[:MAX_HOTWORDS]
        return {"names": names, "words": {w for n in names for w in _words(n)}, "fromFoundry": len(actors or [])}

    def conversion(
        self, session: dict[str, Any], recording: dict[str, Any] | None, bot_online: bool, hotwords: dict[str, Any]
    ) -> dict[str, Any]:
        """How many of a session's clips have been turned into text so far, and how much of it is junk."""
        folder = self.cfg.data_dir / "sessions" / session["id"]
        live = bot_online and recording is not None
        # While the bot is recording it replaces timeline.json every couple of seconds by renaming over it;
        # on Windows that rename fails if we hold the file open. Use the bot's own clip count instead.
        timeline = None if live else self._read_memo(folder / "timeline.json", lambda p: count_segments(p.parent))
        clips = self._read_memo(folder / CACHE_NAME, parse_cache)
        has_transcript = (folder / "transcript.json").exists()
        recorded = max(timeline or 0, (recording or {}).get("clips") or 0, session.get("clips") or 0)
        # The worker deletes its cache once transcript.json holds everything.
        converted = len(clips) if clips is not None else (recorded if has_transcript else 0)
        recorded = max(recorded, converted)
        status = session["status"]
        if status == "failed":
            phase = "failed"  # the worker may still be converting recovered clips; /scrib process finishes it
        elif not bot_online:
            phase = "interrupted"  # the bot marks these failed when it starts again
        elif recording:
            phase = "recording"
        elif status == "summarizing" or (has_transcript and clips is None):
            phase = "summarizing" if status == "summarizing" else "transcribed"
        else:
            phase = "finishing"
        return {
            "sessionId": session["id"],
            "number": session.get("number"),
            "status": status,
            "phase": phase,
            "clips": recorded,
            "converted": converted,
            "pending": recorded - converted,
            "fraction": round(converted / recorded, 4) if recorded else (1.0 if has_transcript else 0.0),
            "progress": session.get("progress"),
            "quality": self.quality(clips or [], hotwords["words"]),
        }

    @staticmethod
    def quality(clips: list[ClipText], hotword_words: set[str]) -> dict[str, Any] | None:
        if not clips:
            return None
        noise = sum(c.noise for c in clips)
        suspect = [c for c in clips if is_hallucination(c.text, hotword_words)]
        repeats = Counter(" ".join(_words(c.text)) for c in clips if c.text)
        return {
            "clips": len(clips),
            "noise": noise,
            "noisePct": round(noise / len(clips) * 100),
            "hallucinations": len(suspect),
            "hallucinationPct": round(len(suspect) / len(clips) * 100),
            "topRepeats": [{"text": t, "count": n} for t, n in repeats.most_common(5) if n >= 3],
        }

    def _measure(self, conversions: list[dict[str, Any]], queued: int | None, worker: dict[str, Any]) -> dict[str, Any]:
        """Throughput (clips converted per minute) and queue trend over the recent window."""
        now = self.clock()
        counts = {c["sessionId"]: c["converted"] for c in conversions}
        live = worker.get("liveClips") or {}
        done, failed = int(live.get("done") or 0), int(live.get("failed") or 0)
        self._samples.append((now, counts, queued, done, failed))
        while self._samples and now - self._samples[0][0] > RATE_WINDOW_S:
            self._samples.popleft()
        first_t, first_counts, first_q, first_done, first_failed = self._samples[0]
        span = now - first_t
        rate = trend = None
        failed_recently = max(0, failed - first_failed) if failed >= first_failed else failed  # worker restarted
        if span >= MIN_RATE_SPAN_S:
            by_session = sum(max(0, n - first_counts[sid]) for sid, n in counts.items() if sid in first_counts)
            by_worker = (done + failed - first_done - first_failed) if done >= first_done else 0
            rate = round(max(by_session, by_worker) / span * 60, 1)
            if queued is not None and first_q is not None:
                trend = round((queued - first_q) / span * 60, 1)

        # Stuck: work waiting, nothing converted for a while.
        total = sum(counts.values()) + done + failed
        if self._progress_seen is None or total != self._progress_seen[0]:
            self._progress_seen = (total, now)
        idle_for = now - self._progress_seen[1]
        pending = sum(c["pending"] for c in conversions)
        paused = bool(worker.get("paused"))
        return {
            "paused": paused,
            "pausedReason": worker.get("pausedReason"),
            "worker": worker.get("stats"),  # the worker's own per-clip timing, when it reports it
            "recovered": worker.get("recovered"),
            "depth": queued,
            "pendingClips": pending,
            "ratePerMin": rate,
            "trendPerMin": trend,
            "etaSec": round(pending / rate * 60) if rate and pending else (0 if not pending else None),
            "windowSec": round(span),
            "liveFailedRecently": failed_recently,
            "noProgressSec": round(idle_for),
            "stalled": bool(queued) and not paused and idle_for >= STALL_AFTER_S,
        }

    def _track_crash(self, bot_online: bool, recordings: list[dict[str, Any]], now_iso: str | None) -> None:
        """Remember what was recording, so a bot that disappears mid-session is called out."""
        if bot_online:
            if self._crash:
                self.logfile.event("bot is back online")
            self._crash = None
            self._last_recordings = [{"sessionId": r["sessionId"], "number": r.get("number")} for r in recordings]
            self._last_online_at = now_iso
            return
        if self._last_recordings and not self._crash:
            folder = self.cfg.data_dir / "sessions"
            self._crash = {
                "sessions": self._last_recordings,
                "lastSeenAt": self._last_online_at,
                # A .tmp left next to timeline.json means a timeline write never completed.
                "timelineTmp": [r["number"] for r in self._last_recordings
                                if (folder / r["sessionId"] / "timeline.json.tmp").exists()],
            }
            self.logfile.event(f"bot went offline while recording session(s) {[r['number'] for r in self._last_recordings]}")
            self._last_recordings = []

    def alerts(
        self,
        status: dict[str, Any],
        bot_online: bool,
        worker: dict[str, Any],
        recordings: list[dict[str, Any]],
        conversions: list[dict[str, Any]],
        queue: dict[str, Any],
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        now = self.clock()

        def add(key: str, level: str, text: str) -> None:
            out.append({"key": key, "level": level, "text": text})

        if self._crash and not bot_online:
            nums = ", ".join(str(s["number"]) for s in self._crash["sessions"])
            seen = self._crash["lastSeenAt"]
            when = f" (last seen {datetime.fromisoformat(seen.replace('Z', '+00:00')).astimezone().strftime('%H:%M')})" if seen else ""
            tmp = (" A timeline write was cut off mid-way (timeline.json.tmp left behind), which points to the "
                   "bot crashing while saving it.") if self._crash["timelineTmp"] else ""
            add("crash", "err", f"The bot stopped while recording session {nums}{when}. Nothing said since then is recorded. "
                f"Start the bot with .\\start.ps1, then run /scrib process.{tmp}")

        live_ids = set()
        for r in recordings:
            sid = r["sessionId"]
            live_ids.add(sid)
            clips = r.get("clips") or 0
            seen = self._clip_seen.get(sid)
            if seen is None or seen[0] != clips:
                self._clip_seen[sid] = (clips, now)
            elif r.get("speakers") and now - seen[1] >= SILENT_AFTER_S:
                add(f"silent-{sid}", "warn", f"Session {r.get('number')}: no new audio for {_dur(now - seen[1])}. "
                    "If people are talking, the bot may have lost the voice connection (it doesn't announce that); "
                    "/scrib stop and /scrib start will reconnect.")
        for sid in list(self._clip_seen):
            if sid not in live_ids:
                del self._clip_seen[sid]

        if queue["paused"]:
            why = f" ({queue['pausedReason']})" if queue["pausedReason"] else ""
            add("paused", "warn", f"Transcription is paused{why} with {_plural(queue['depth'] or 0, 'clip')} queued. "
                "Resume it: Invoke-RestMethod -Method Post http://127.0.0.1:7421/resume -ContentType application/json -Body '{}'")
        if queue["stalled"]:
            add("stalled", "err", f"The transcription worker has {_plural(queue['depth'], 'clip')} queued but hasn't converted "
                f"anything for {_dur(queue['noProgressSec'])}. Check its window for errors; restarting it drops the queue "
                "(the audio stays, and /scrib process redoes it).")
        elif recordings and queue["trendPerMin"] is not None and queue["trendPerMin"] > BEHIND_TREND_PER_MIN and queue["windowSec"] >= 60:
            eta = f" At the current rate the transcript will be ready about {_dur(queue['etaSec'])} after /scrib stop." if queue["etaSec"] else ""
            add("behind", "warn", f"Transcription is falling behind: {_plural(queue['pendingClips'], 'clip')} waiting, "
                f"growing by {queue['trendPerMin']:g}/min.{eta}")
        if queue["liveFailedRecently"]:
            add("live-failed", "warn", f"{_plural(queue['liveFailedRecently'], 'live clip')} failed to transcribe in the last "
                f"{_dur(queue['windowSec'])}. They're retried at /scrib stop; the worker's window has the error.")

        for c in conversions:
            if c["phase"] != "failed":
                continue
            done = f"{c['converted']} of {_plural(c['clips'], 'clip')} converted"
            if queue["depth"]:
                add(f"failed-{c['sessionId']}", "warn",
                    f"Session {c['number']} is marked failed in Discord, but the worker is still converting its clips "
                    f"from disk ({done}). When the worker queue is empty, run /scrib process session:{c['number']}.")
            else:
                add(f"failed-{c['sessionId']}", "warn",
                    f"Session {c['number']} failed ({done}). Run /scrib process session:{c['number']} to finish it.")

        for c in conversions:
            q = c["quality"]
            if q and q["clips"] >= 30 and q["hallucinationPct"] >= 15:
                add(f"quality-{c['sessionId']}", "warn",
                    f"Session {c['number']}: {q['hallucinationPct']}% of converted clips look like hallucinations "
                    f"(e.g. names from the hotword list instead of speech). See docs/assessment/01-performance-and-cpu-offload.md (R1).")

        llm = status.get("llm") or {}
        if llm.get("provider") == "openai-compatible" and not llm.get("model"):
            add("llm-model", "warn", "Summaries will fail: LLM_PROVIDER is openai-compatible but LLM_MODEL is empty in .env.")

        for a in out:
            if a["key"] not in self._raised:
                self.logfile.event(f"alert: {a['text']}")
        self._raised = {a["key"] for a in out}
        return out

    def shutdown_advice(
        self,
        bot_online: bool,
        worker: dict[str, Any],
        recordings: list[dict[str, Any]],
        conversions: list[dict[str, Any]],
        queue: dict[str, Any],
    ) -> dict[str, Any]:
        """state: "safe" (nothing would be lost), "wait" (work in progress) or "no" (a recording is live)."""
        queued = queue["depth"]
        eta = f", about {_dur(queue['etaSec'])} at the current rate" if queue["etaSec"] else ""
        if bot_online and recordings:
            return {
                "state": "no",
                "title": "Don't shut down: recording in progress",
                "reasons": [f"Session {r['number']} is recording. Run /scrib stop in Discord first." for r in recordings],
            }
        reasons: list[str] = []
        notes: list[str] = []
        if bot_online:
            for c in conversions:
                if c["phase"] == "finishing":
                    pct = c["progress"] if c["progress"] is not None else c["fraction"]
                    reasons.append(f"Session {c['number']} is being transcribed ({round(pct * 100)}%, {_plural(c['pending'], 'clip')} left).")
                elif c["phase"] in ("summarizing", "transcribed"):
                    reasons.append(f"Session {c['number']} is being summarized.")
                elif c["phase"] == "failed":
                    notes.append(f"Session {c['number']} failed; run /scrib process session:{c['number']} to finish it.")
            if reasons and not worker.get("reachable"):
                reasons.append("The worker is unreachable, so this can't finish until it's running again.")
        else:
            notes = [f"Session {c['number']} was interrupted; run /scrib process after restarting the bot." for c in conversions]
        if queued:
            who = "the worker" if bot_online else "the worker (the bot is already stopped)"
            held = " It is paused, so they won't finish until it's resumed." if queue.get("paused") else ""
            after = ("Stopping the worker now drops the queue; it re-queues the clips from disk when it starts again."
                     if queue.get("recovered") is not None else "Stopping the worker now drops them.")
            reasons.append(f"{_plural(queued, 'clip')} still waiting in {who}{eta}.{held} {after}")
        if reasons:
            return {"state": "wait", "title": "Wait: still transcribing", "reasons": reasons + notes}
        if not bot_online:
            idle = "and the worker is idle" if worker.get("reachable") else "and the worker isn't running"
            return {"state": "safe", "title": "Safe to shut down", "reasons": [f"The bot is already stopped {idle}.", *notes]}
        return {
            "state": "safe",
            "title": "Safe to shut down",
            "reasons": ["Nothing is recording, transcribing or summarizing, and the worker queue is empty.", *notes],
        }

    def _read_memo(self, path: Path, parse: Callable[[Path], Any]) -> Any:
        """parse(path), re-run only when the file changes. Missing → None; unreadable → last good value."""
        try:
            st = path.stat()
        except OSError:
            self._file_memo.pop(path, None)
            return None
        key = (st.st_mtime_ns, st.st_size)
        memo = self._file_memo.get(path)
        if memo and memo[0] == key:
            return memo[1]
        try:
            value = parse(path)
        except (OSError, ValueError, KeyError, TypeError):
            return memo[1] if memo else None  # e.g. caught mid-write
        self._file_memo[path] = (key, value)
        return value


# ---------------------------------------------------------------- web server


def is_local_host_header(host: str | None) -> bool:
    """Rejects requests addressed to other host names (DNS rebinding)."""
    if not host:
        return False
    name = host.rsplit(":", 1)[0] if not host.endswith("]") else host
    return name.lower() in LOCAL_HOSTS


def make_handler(monitor: Monitor) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "ScribMonitor"

        def do_GET(self) -> None:  # noqa: N802 - http.server API
            if not is_local_host_header(self.headers.get("Host")):
                return self._send(403, b"forbidden", "text/plain")
            url = urlsplit(self.path)
            if url.path in ("/", "/dashboard"):
                status = monitor.status()
                if status["monitor"]["bot"] == "online":
                    # One page to watch: the bot's own dashboard (it asks for the API token itself).
                    self.send_response(302)
                    self.send_header("Location", f"{monitor.cfg.bot_url}/")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    return
                try:
                    self._send(200, OFFLINE_PAGE.read_bytes(), "text/html; charset=utf-8")
                except OSError:
                    self._send(500, f"Page not found at {OFFLINE_PAGE}".encode(), "text/plain")
            elif url.path == "/status":
                self._json(monitor.status())
            elif url.path == "/monitor/recent-log":
                self._json({"enabled": monitor.logfile.folder is not None,
                            "folder": str(monitor.logfile.folder or ""), "lines": monitor.logfile.tail(40)})
            elif url.path == "/health":
                self._json({"ok": True, "name": "scribmonitor"})
            else:
                self._send(404, b"not found", "text/plain")

        def _json(self, data: Any) -> None:
            self._send(200, json.dumps(data).encode("utf-8"), "application/json")

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - keep the console quiet
            pass

    return Handler


class MonitorServer(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second process bind a port that's already in use, so two monitors
    # would silently share 7422 and answer requests at random. Elsewhere it only skips TIME_WAIT.
    allow_reuse_address = sys.platform != "win32"


def main(argv: list[str] | None = None) -> int:
    cfg = Config.load()
    parser = argparse.ArgumentParser(description="Optional local web monitor for ScribBot.")
    parser.add_argument("--port", type=int, default=cfg.port, help=f"port to serve on (default {cfg.port}, MONITOR_PORT in .env)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the page in a browser")
    parser.add_argument("--no-log-file", action="store_true", help=f"don't copy the bot's log to {cfg.log_dir}")
    args = parser.parse_args(argv)

    monitor = Monitor(cfg, logfile=LogFile(None if args.no_log_file else cfg.log_dir))
    try:
        server = MonitorServer(("127.0.0.1", args.port), make_handler(monitor))
    except OSError as err:
        log(f"can't listen on 127.0.0.1:{args.port}: {err}. Is the monitor already running? Use --port to pick another.")
        return 1
    server.daemon_threads = True
    stop = threading.Event()
    threading.Thread(target=monitor.run_sampler, args=(stop,), daemon=True, name="sampler").start()

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
