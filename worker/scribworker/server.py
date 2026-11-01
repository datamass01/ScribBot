"""HTTP API the bot calls.

- POST /clips/transcribe: live, during the session. One finished clip is transcribed into the
  session's cache (and its WAV deleted, if asked). Fire-and-forget.
- POST /jobs/transcribe: at the end. Builds transcript.json from the cache plus any clips not
  done live, and reports progress via GET /jobs/{id}.
- POST /pause, POST /resume: hold the queue (the clip in progress finishes) and release it.
  Both need a JSON body (e.g. {}), so a web page can't trigger them cross-site.

All work runs on one background thread: Whistle is one model per process and not thread-safe.
The queue is ordered by priority (docs/assessment/02 S5): live clips first, then the end-of-session
job of a session that was just live and clips recovered after a restart, then everything else
(e.g. /scrib process on an old session). It lives in memory, so on start the worker re-queues clips
that have audio but no text yet (WORKER_RECOVER_HOURS): a restart costs time, not clips.

After WORKER_RELOAD_AFTER_FAILURES model errors in a row (a CUDA fault, say) the model is dropped
and reloaded; if that fails the process exits non-zero so a supervisor restarts it (02 S7). A clip
running longer than WORKER_SLOW_CLIP_SECONDS is logged with its path.
"""

from __future__ import annotations

import itertools
import logging
import os
import queue
import threading
import time
import uuid
import wave
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import load_settings
from .logfile import DailyFileHandler
from .transcribe import (
    Transcriber,
    glossary_names,
    is_noise,
    make_transcriber,
    supported_languages,
    transcribe_clip,
    transcribe_session,
    unfinished_clips,
    whisper_options,
)

STATS_WINDOW_S = 300  # /health stats cover the last 5 minutes of model calls

# Queue priorities: lower runs first.
PRIORITY_PRELOAD = -1
PRIORITY_LIVE = 0
PRIORITY_CURRENT = 1  # end-of-session job of a session that had live clips recently; recovered clips
PRIORITY_OTHER = 2
RECENTLY_LIVE_S = 30 * 60

# Errors that mean "this clip's file is bad", not "the model is broken".
FILE_ERRORS = (OSError, EOFError, wave.Error)


class PauseRequest(BaseModel):
    reason: str | None = None


@dataclass
class ClipStat:
    at: float  # time.monotonic() when the call finished
    audio_s: float
    wall_s: float
    skipped: bool  # VAD found no speech, model not run
    kept: bool  # at least one line survives the noise filter
    filler: bool = False  # only a stock silence phrase on a short, unsure clip; dropped (01 R9)


class ModelBroken(RuntimeError):
    """Too many model errors in a row: the transcriber should be reloaded."""


class MeteredTranscriber:
    """Wraps the model to time every call and count failures, without changing what it returns."""

    def __init__(self, inner: Transcriber, stats: deque[ClipStat], health: dict | None = None, reload_after: int = 5):
        self.inner = inner
        self.stats = stats
        self.health = health if health is not None else {}
        self.reload_after = reload_after
        self.model_name = getattr(inner, "model_name", "unknown")
        self.device = getattr(inner, "device", "unknown")

    def transcribe_file(self, path: Path, *, language, keywords):
        try:
            with wave.open(str(path), "rb") as w:
                audio_s = w.getnframes() / float(w.getframerate() or 1)
        except FILE_ERRORS:
            audio_s = 0.0
        t0 = time.monotonic()
        self.health["current"] = (str(path), t0)
        try:
            segs, lang = self.inner.transcribe_file(path, language=language, keywords=keywords)
        except FILE_ERRORS:
            raise  # a bad file, not a bad model
        except Exception:
            self.health["consecutive_failures"] = self.health.get("consecutive_failures", 0) + 1
            if self.reload_after > 0 and self.health["consecutive_failures"] >= self.reload_after:
                self.health["broken"] = True
            raise
        finally:
            self.health["current"] = None
        self.health["consecutive_failures"] = 0
        now = time.monotonic()
        self.stats.append(ClipStat(now, audio_s, now - t0, bool(getattr(self.inner, "last_skipped", False)),
                                   any(not is_noise(s) for s in segs), bool(getattr(self.inner, "last_filler", False))))
        return segs, lang


def summarize_stats(stats: list[ClipStat], now: float) -> dict:
    recent = [s for s in stats if now - s.at <= STATS_WINDOW_S]
    if not recent:
        return {"windowSec": STATS_WINDOW_S, "clips": 0}
    walls = sorted(s.wall_s for s in recent)
    span = max(now - recent[0].at, 1.0) if len(recent) > 1 else STATS_WINDOW_S
    audio = sum(s.audio_s for s in recent)
    return {
        "windowSec": STATS_WINDOW_S,
        "clips": len(recent),
        "clipsPerMin": round(len(recent) / span * 60, 1),
        "avgSeconds": round(sum(walls) / len(walls), 2),
        "p95Seconds": round(walls[min(len(walls) - 1, int(len(walls) * 0.95))], 2),
        "avgAudioSeconds": round(audio / len(recent), 2),
        "realTimeFactor": round(sum(walls) / audio, 2) if audio else None,
        "skippedByVad": sum(s.skipped for s in recent),
        "fillerDropped": sum(s.filler for s in recent),
        "keptPct": round(sum(s.kept for s in recent) / len(recent) * 100),
    }

log = logging.getLogger("scribworker")


class TranscribeRequest(BaseModel):
    sessionDir: str
    keywords: list[str] = []
    language: str | None = None
    deleteAudio: bool = False


class ClipRequest(TranscribeRequest):
    file: str  # relative to sessionDir, as in timeline.json


@dataclass
class Job:
    id: str
    session_dir: Path
    keywords: list[str]
    language: str | None
    delete_audio: bool
    status: Literal["queued", "running", "done", "failed"] = "queued"
    progress: float = 0.0
    error: str | None = None
    lines: int = field(default=0)

    def public(self) -> dict:
        return {"id": self.id, "status": self.status, "progress": self.progress, "error": self.error, "lines": self.lines}


def create_app(
    transcriber_factory=None,
    data_dir: Path | None = None,
    default_language: str | None = None,
    preload: bool = False,
    recover: bool | None = None,
) -> FastAPI:
    settings = load_settings()
    data_root = (data_dir or settings.data_dir).resolve()
    language = default_language if default_language is not None else settings.language
    languages = supported_languages(settings.stt_engine)
    if language and languages is not None and language not in languages:
        raise ValueError(f"STT_LANGUAGE={language!r}: {settings.stt_engine} supports {', '.join(sorted(languages))}")
    factory = transcriber_factory or (lambda: make_transcriber(settings))
    engine_label = f"whisper-{settings.whisper_model}" if settings.stt_engine == "whisper" else "cactus-whistle"
    engine_device = settings.whisper_device if settings.stt_engine == "whisper" else "cpu"

    app = FastAPI(title="ScribBot worker")
    jobs: dict[str, Job] = {}
    pending: queue.PriorityQueue[tuple[int, int, Callable[[], None]]] = queue.PriorityQueue()
    order = itertools.count()  # FIFO within a priority
    live_clips = {"done": 0, "failed": 0}
    state: dict = {"transcriber": None, "load_error": None, "paused_reason": None, "held": 0, "recovered": {"sessions": 0, "clips": 0}}
    # Shared with MeteredTranscriber: the clip in progress, failures in a row, and reload bookkeeping.
    health: dict = {"current": None, "consecutive_failures": 0, "broken": False, "reloads": 0, "slow_logged": None}
    last_live: dict[Path, float] = {}  # session dir -> monotonic time of its last live clip
    running = threading.Event()  # cleared while paused
    running.set()
    stats: deque[ClipStat] = deque(maxlen=2000)

    def enqueue(priority: int, task: Callable[[], None]) -> None:
        pending.put((priority, next(order), task))

    def get_transcriber() -> Transcriber:
        if state["transcriber"] is None:
            # lazy: the first load downloads the weights
            state["transcriber"] = MeteredTranscriber(factory(), stats, health, settings.reload_after_failures)
        return state["transcriber"]

    def reload_model() -> None:
        """Drop and reload the model after repeated errors (02 S7). Runs on the transcription thread."""
        failures = health["consecutive_failures"]
        log.error("%d model errors in a row; reloading the speech-to-text model", failures)
        state["transcriber"] = None
        health["broken"] = False
        health["consecutive_failures"] = 0
        try:
            import gc

            gc.collect()
            get_transcriber()
            health["reloads"] += 1
            state["load_error"] = None
            log.info("model reloaded")
        except Exception as err:  # noqa: BLE001
            state["load_error"] = f"reload failed: {err}"
            log.exception("reloading the model failed; exiting so a supervisor can restart the worker")
            if exit_on_broken:
                logging.shutdown()
                os._exit(3)

    def run_session(job: Job) -> None:
        job.status = "running"
        try:
            transcript = transcribe_session(
                job.session_dir,
                get_transcriber(),
                language=job.language or language,
                keywords=job.keywords,
                delete_audio=job.delete_audio,
                on_progress=lambda f: setattr(job, "progress", round(f, 3)),
            )
            job.lines = len(transcript.lines)
            job.status = "done"
            log.info("job %s done: %d lines", job.id, job.lines)
        except Exception as err:
            log.exception("job %s failed", job.id)
            job.status = "failed"
            job.error = f"{type(err).__name__}: {err}"

    def run_clip(req: ClipRequest, session_dir: Path) -> None:
        try:
            transcribe_clip(
                session_dir,
                req.file,
                get_transcriber(),
                language=req.language or language,
                keywords=req.keywords,
                delete_audio=req.deleteAudio,
            )
            live_clips["done"] += 1
        except Exception:
            # Not fatal: the clip is retried by the end-of-session job.
            live_clips["failed"] += 1
            log.exception("live transcription of %s failed", req.file)

    def run() -> None:
        while True:
            running.wait()
            _, _, task = pending.get()
            if not running.is_set():  # paused while waiting for work: hold this task until resumed
                state["held"] = 1
                running.wait()
                state["held"] = 0
            try:
                task()
            except Exception:  # noqa: BLE001 - the transcription thread must never die
                log.exception("task failed")
            if health["broken"]:
                reload_model()

    def watchdog() -> None:
        """Log a clip that runs unusually long, once, so the culprit is known (02 S7)."""
        while True:
            time.sleep(min(10.0, max(1.0, settings.slow_clip_seconds / 4)))
            current = health["current"]
            if current and settings.slow_clip_seconds > 0:
                path, t0 = current
                if time.monotonic() - t0 > settings.slow_clip_seconds and health["slow_logged"] != (path, t0):
                    health["slow_logged"] = (path, t0)
                    log.warning("clip %s has been transcribing for over %.0f s", path, settings.slow_clip_seconds)

    def recover_unfinished() -> None:
        """Re-queue clips that were recorded but never transcribed (the old queue died with the old process)."""
        found = unfinished_clips(data_root, settings.recover_hours)
        if not found:
            return
        try:
            names = glossary_names((settings.campaign_dir / "glossary.md").read_text("utf-8"))
        except OSError:
            names = []
        for session_dir, file in found:
            req = ClipRequest(sessionDir=str(session_dir), file=file, keywords=names, deleteAudio=settings.delete_audio)
            enqueue(PRIORITY_CURRENT, lambda req=req, d=session_dir: run_clip(req, d))
        sessions = len({d for d, _ in found})
        state["recovered"] = {"sessions": sessions, "clips": len(found)}
        log.info("re-queued %d untranscribed clip(s) from %d session(s)", len(found), sessions)

    def preload_model() -> None:
        # Load at startup so a bad STT_ENGINE/WHISPER_DEVICE setup shows now, not mid-session.
        try:
            get_transcriber()
            state["load_error"] = None
        except Exception as err:
            state["load_error"] = str(err)
            log.exception("could not load the %s speech-to-text model", settings.stt_engine)

    exit_on_broken = preload  # the real server; tests never exit the process
    threading.Thread(target=run, daemon=True, name="transcriber").start()
    threading.Thread(target=watchdog, daemon=True, name="watchdog").start()
    if preload:
        enqueue(PRIORITY_PRELOAD, preload_model)  # same thread as every transcription: the model is never shared
    # The real server preloads and recovers; tests opt in to each.
    if preload if recover is None else recover:
        recover_unfinished()
    opts = whisper_options(settings) if settings.stt_engine == "whisper" else None

    def checked_session_dir(req: TranscribeRequest) -> Path:
        session_dir = Path(req.sessionDir).resolve()
        # Only sessions under DATA_DIR: the worker must not read arbitrary paths it is handed.
        if not session_dir.is_relative_to(data_root):
            raise HTTPException(400, f"sessionDir must be inside {data_root}")
        if req.language and languages is not None and req.language not in languages:
            raise HTTPException(400, f"language must be one of {sorted(languages)}")
        return session_dir

    def current_clip() -> dict | None:
        current = health["current"]
        if not current:
            return None
        path, t0 = current
        return {"file": path, "seconds": round(time.monotonic() - t0, 1)}

    @app.get("/health")
    def health_route() -> dict:
        t = state["transcriber"]
        return {
            "ok": True,
            "model": getattr(t, "model_name", engine_label) if t else engine_label,
            "device": getattr(t, "device", engine_device) if t else f"{engine_device} (not loaded yet)",
            "engine": settings.stt_engine,
            "loadError": state["load_error"],
            "language": language or "auto",
            "queued": pending.qsize() + state["held"],
            "liveClips": dict(live_clips),
            "paused": not running.is_set(),
            "pausedReason": state["paused_reason"],
            "recovered": dict(state["recovered"]),
            "current": current_clip(),
            "consecutiveFailures": health["consecutive_failures"],
            "modelReloads": health["reloads"],
            "stats": summarize_stats(list(stats), time.monotonic()),
            "options": opts and {
                "beamSize": opts.beam_size,
                "maxHotwords": opts.max_hotwords,
                "hotwordsMinSeconds": opts.hotwords_min_seconds,
                "vad": opts.vad,
                "vadThreshold": opts.vad_threshold,
            },
        }

    @app.post("/pause")
    def pause(req: PauseRequest) -> dict:
        running.clear()
        state["paused_reason"] = req.reason
        log.info("paused (%s); %d queued", req.reason or "no reason given", pending.qsize() + state["held"])
        return {"paused": True, "queued": pending.qsize() + state["held"]}

    @app.post("/resume")
    def resume(_: PauseRequest) -> dict:
        running.set()
        state["paused_reason"] = None
        log.info("resumed; %d queued", pending.qsize())
        return {"paused": False, "queued": pending.qsize()}

    @app.post("/jobs/transcribe")
    def submit(req: TranscribeRequest) -> dict:
        session_dir = checked_session_dir(req)
        if not (session_dir / "timeline.json").exists():
            raise HTTPException(404, "timeline.json not found in sessionDir")
        for job in jobs.values():
            if job.session_dir == session_dir and job.status in ("queued", "running"):
                return job.public()
        job = Job(
            id=uuid.uuid4().hex[:12],
            session_dir=session_dir,
            keywords=req.keywords,
            language=req.language,
            delete_audio=req.deleteAudio,
        )
        jobs[job.id] = job
        live_at = last_live.get(session_dir)
        recent = live_at is not None and time.monotonic() - live_at < RECENTLY_LIVE_S
        enqueue(PRIORITY_CURRENT if recent else PRIORITY_OTHER, lambda: run_session(job))
        return job.public()

    @app.post("/clips/transcribe", status_code=202)
    def submit_clip(req: ClipRequest) -> dict:
        session_dir = checked_session_dir(req)
        clip = (session_dir / req.file).resolve()
        if not clip.is_relative_to(session_dir) or clip.suffix.lower() != ".wav":
            raise HTTPException(400, "file must be a .wav inside sessionDir")
        last_live[session_dir] = time.monotonic()
        enqueue(PRIORITY_LIVE, lambda: run_clip(req, session_dir))
        return {"queued": True}

    @app.get("/jobs/{job_id}")
    def status(job_id: str) -> dict:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job")
        return job.public()

    return app


def main() -> None:
    settings = load_settings()
    fmt = "%(asctime)s %(levelname)s %(name)s: %(message)s"
    logging.basicConfig(level=logging.INFO, format=fmt)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # weight download chatter
    if settings.log_retention_days > 0:
        # data/logs/worker-YYYY-MM-DD.log, so a crash leaves evidence (02 S9).
        handler = DailyFileHandler(settings.data_dir / "logs", "worker", settings.log_retention_days)
        handler.setFormatter(logging.Formatter(fmt))
        logging.getLogger().addHandler(handler)
    import atexit

    atexit.register(lambda: log.info("worker exiting"))
    if settings.stt_engine == "whisper":
        engine = f"whisper model={settings.whisper_model} device={settings.whisper_device} compute={settings.whisper_compute_type or 'auto'}"
    else:
        engine = f"whistle weights={settings.weights or 'default'}"
    log.info("%s language=%s data=%s", engine, settings.language or "auto", settings.data_dir)
    uvicorn.run(create_app(preload=True), host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
