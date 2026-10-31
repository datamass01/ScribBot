"""HTTP API the bot calls.

- POST /clips/transcribe: live, during the session. One finished clip is transcribed into the
  session's cache (and its WAV deleted, if asked). Fire-and-forget.
- POST /jobs/transcribe: at the end. Builds transcript.json from the cache plus any clips not
  done live, and reports progress via GET /jobs/{id}.

All work runs in order on one background thread: Whistle is one model per process and not thread-safe.
"""

from __future__ import annotations

import logging
import queue
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .config import load_settings
from .transcribe import LANGUAGES, Transcriber, WhistleTranscriber, transcribe_clip, transcribe_session

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


def create_app(transcriber_factory=None, data_dir: Path | None = None, default_language: str | None = None) -> FastAPI:
    settings = load_settings()
    data_root = (data_dir or settings.data_dir).resolve()
    language = default_language if default_language is not None else settings.language
    if language and language not in LANGUAGES:
        raise ValueError(f"STT_LANGUAGE={language!r}: Whistle supports {', '.join(sorted(LANGUAGES))}")
    factory = transcriber_factory or (lambda: WhistleTranscriber(settings.weights))

    app = FastAPI(title="ScribBot worker")
    jobs: dict[str, Job] = {}
    pending: queue.Queue[Callable[[], None]] = queue.Queue()
    live_clips = {"done": 0, "failed": 0}
    state: dict[str, Transcriber | None] = {"transcriber": None}

    def get_transcriber() -> Transcriber:
        if state["transcriber"] is None:
            state["transcriber"] = factory()  # lazy: the first load downloads the weights
        return state["transcriber"]

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
            task = pending.get()
            task()

    threading.Thread(target=run, daemon=True, name="transcriber").start()

    def checked_session_dir(req: TranscribeRequest) -> Path:
        session_dir = Path(req.sessionDir).resolve()
        # Only sessions under DATA_DIR: the worker must not read arbitrary paths it is handed.
        if not session_dir.is_relative_to(data_root):
            raise HTTPException(400, f"sessionDir must be inside {data_root}")
        if req.language and req.language not in LANGUAGES:
            raise HTTPException(400, f"language must be one of {sorted(LANGUAGES)}")
        return session_dir

    @app.get("/health")
    def health() -> dict:
        t = state["transcriber"]
        return {
            "ok": True,
            "model": "cactus-whistle",
            "device": getattr(t, "device", "cpu") if t else "cpu (not loaded yet)",
            "language": language or "auto",
            "queued": pending.qsize(),
            "liveClips": dict(live_clips),
        }

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
        pending.put(lambda: run_session(job))
        return job.public()

    @app.post("/clips/transcribe", status_code=202)
    def submit_clip(req: ClipRequest) -> dict:
        session_dir = checked_session_dir(req)
        clip = (session_dir / req.file).resolve()
        if not clip.is_relative_to(session_dir) or clip.suffix.lower() != ".wav":
            raise HTTPException(400, "file must be a .wav inside sessionDir")
        pending.put(lambda: run_clip(req, session_dir))
        return {"queued": True}

    @app.get("/jobs/{job_id}")
    def status(job_id: str) -> dict:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "unknown job")
        return job.public()

    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # weight download chatter
    settings = load_settings()
    log.info("whistle weights=%s language=%s data=%s", settings.weights or "default", settings.language or "auto", settings.data_dir)
    uvicorn.run(create_app(), host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
