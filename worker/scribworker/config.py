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


@dataclass(frozen=True)
class Settings:
    weights: str | None
    language: str | None
    data_dir: Path
    host: str
    port: int


def load_settings() -> Settings:
    worker_url = urlparse(os.getenv("WORKER_URL") or "http://127.0.0.1:7421")
    weights = os.getenv("WHISTLE_WEIGHTS") or None
    return Settings(
        weights=str(_resolve(weights)) if weights else None,
        language=(os.getenv("STT_LANGUAGE") or "").strip().lower() or None,
        data_dir=_resolve(os.getenv("DATA_DIR") or "./data"),
        host=worker_url.hostname or "127.0.0.1",
        port=worker_url.port or 7421,
    )
