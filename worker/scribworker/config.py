"""Worker settings, read from the repo-root .env shared with the bot."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")


def _resolve(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else (REPO_ROOT / path).resolve()


STT_ENGINES = ("whistle", "whisper")
WHISPER_DEVICES = ("cuda", "cpu")


@dataclass(frozen=True)
class Settings:
    weights: str | None
    language: str | None
    data_dir: Path
    host: str
    port: int
    # Speech-to-text engine: "whistle" (17 MB, CPU) or "whisper" (faster-whisper, CUDA or CPU).
    stt_engine: str = "whistle"
    whisper_model: str = "large-v3"
    whisper_device: str = "cuda"
    # None: float16 on CUDA, int8 on CPU.
    whisper_compute_type: str | None = None
    whisper_beam_size: int = 5
    # Hotwords go into Whisper's prompt; long lists get "transcribed" instead of quiet speech.
    # The bot sends party names first, then the glossary, then Foundry actors, so a cap keeps the first two.
    whisper_max_hotwords: int = 30
    whisper_hotwords_min_seconds: float = 1.5
    # Silero voice-activity detection on the CPU: clips without speech never reach the model.
    whisper_vad: bool = True
    whisper_vad_threshold: float = 0.5
    # Drop a clip that is only "thank you"/"you"/"bye"… when it's this short and decoded with low
    # confidence (docs/assessment/01 R9). 0 disables.
    whisper_filler_max_seconds: float = 2.0
    whisper_filler_max_probability: float = 0.7
    # Same variable as the bot's; used for clips the worker re-queues itself after a restart.
    delete_audio: bool = True
    # On start, re-queue clips of sessions touched in the last N hours that have audio but no text yet.
    recover_hours: float = 12.0
    campaign_dir: Path = REPO_ROOT / "campaign"
    # Reload the model after this many errors in a row; exit if that fails (0 = never).
    reload_after_failures: int = 5
    # Log a clip that has been transcribing longer than this (0 = never).
    slow_clip_seconds: float = 60.0
    # data/logs/worker-YYYY-MM-DD.log, kept this many days (0 = console only). Shared with the bot.
    log_retention_days: float = 14.0


def _choice(name: str, default: str, allowed: tuple[str, ...]) -> str:
    value = (os.getenv(name) or default).strip().lower()
    if value not in allowed:
        raise ValueError(f"{name}={value!r}: must be one of {', '.join(allowed)}")
    return value


def _bool(name: str, default: bool) -> bool:
    value = (os.getenv(name) or "").strip().lower()
    return default if not value else value in {"1", "true", "yes", "on"}


def _number(name: str, default: float, minimum: float = 0) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as err:
        raise ValueError(f"{name}={raw!r}: must be a number") from err
    if value < minimum:
        raise ValueError(f"{name}={raw!r}: must be at least {minimum:g}")
    return value


def load_settings() -> Settings:
    worker_url = urlparse(os.getenv("WORKER_URL") or "http://127.0.0.1:7421")
    weights = os.getenv("WHISTLE_WEIGHTS") or None
    return Settings(
        weights=str(_resolve(weights)) if weights else None,
        language=(os.getenv("STT_LANGUAGE") or "").strip().lower() or None,
        data_dir=_resolve(os.getenv("DATA_DIR") or "./data"),
        host=worker_url.hostname or "127.0.0.1",
        port=worker_url.port or 7421,
        stt_engine=_choice("STT_ENGINE", "whistle", STT_ENGINES),
        whisper_model=(os.getenv("WHISPER_MODEL") or "large-v3").strip(),
        whisper_device=_choice("WHISPER_DEVICE", "cuda", WHISPER_DEVICES),
        whisper_compute_type=(os.getenv("WHISPER_COMPUTE_TYPE") or "").strip().lower() or None,
        whisper_beam_size=int(_number("WHISPER_BEAM_SIZE", 5, minimum=1)),
        whisper_max_hotwords=int(_number("WHISPER_MAX_HOTWORDS", 30)),
        whisper_hotwords_min_seconds=_number("WHISPER_HOTWORDS_MIN_SECONDS", 1.5),
        whisper_vad=_bool("WHISPER_VAD", True),
        whisper_vad_threshold=_number("WHISPER_VAD_THRESHOLD", 0.5),
        whisper_filler_max_seconds=_number("WHISPER_FILLER_MAX_SECONDS", 2.0),
        whisper_filler_max_probability=_number("WHISPER_FILLER_MAX_PROBABILITY", 0.7),
        delete_audio=_bool("DELETE_AUDIO_AFTER_TRANSCRIBE", True),
        recover_hours=_number("WORKER_RECOVER_HOURS", 12),
        campaign_dir=_resolve(os.getenv("CAMPAIGN_DIR") or "./campaign"),
        reload_after_failures=int(_number("WORKER_RELOAD_AFTER_FAILURES", 5)),
        slow_clip_seconds=_number("WORKER_SLOW_CLIP_SECONDS", 60),
        log_retention_days=_number("LOG_RETENTION_DAYS", 14),
    )
