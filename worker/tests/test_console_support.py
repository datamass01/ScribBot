"""What the Console (console/) relies on from the worker: /restart and the settings catalog."""

from __future__ import annotations

import json
import time
from dataclasses import fields
from pathlib import Path

from fastapi.testclient import TestClient

from scribworker.config import REPO_ROOT, Settings
from scribworker.server import RESTART_EXIT_CODE, create_app


class NoModel:
    def transcribe_file(self, path, *, language, keywords):  # pragma: no cover - never called
        raise AssertionError("no clips in this test")


def test_restart_answers_then_exits_with_the_restart_code(tmp_path: Path):
    exits: list[int] = []
    app = create_app(transcriber_factory=NoModel, data_dir=tmp_path, default_language="en", recover=False, exit_process=exits.append)
    client = TestClient(app)
    assert client.post("/restart", content=b"", headers={"content-type": "text/plain"}).status_code == 422  # JSON body required
    res = client.post("/restart", json={"reason": "settings changed"})
    assert res.status_code == 200
    assert res.json() == {"restarting": True, "queued": 0}
    deadline = time.monotonic() + 3
    while not exits and time.monotonic() < deadline:
        time.sleep(0.05)
    assert exits == [RESTART_EXIT_CODE]


# Worker variables in shared/schemas/settings.json and the Settings field each one sets.
FIELDS = {
    "STT_ENGINE": "stt_engine",
    "WHISPER_MODEL": "whisper_model",
    "WHISPER_DEVICE": "whisper_device",
    "WHISPER_BEAM_SIZE": "whisper_beam_size",
    "WHISPER_MAX_HOTWORDS": "whisper_max_hotwords",
    "WHISPER_HOTWORDS_MIN_SECONDS": "whisper_hotwords_min_seconds",
    "WHISPER_VAD": "whisper_vad",
    "WHISPER_VAD_THRESHOLD": "whisper_vad_threshold",
    "WHISPER_FILLER_MAX_SECONDS": "whisper_filler_max_seconds",
    "WHISPER_FILLER_MAX_PROBABILITY": "whisper_filler_max_probability",
    "DELETE_AUDIO_AFTER_TRANSCRIBE": "delete_audio",
    "WORKER_RECOVER_HOURS": "recover_hours",
    "WORKER_RELOAD_AFTER_FAILURES": "reload_after_failures",
    "WORKER_SLOW_CLIP_SECONDS": "slow_clip_seconds",
    "LOG_RETENTION_DAYS": "log_retention_days",
}


def test_settings_catalog_defaults_match_the_worker():
    """The Console shows these defaults and offers "Reset to default"; they must be the worker's own."""
    catalog = {s["key"]: s for s in json.loads((REPO_ROOT / "shared" / "schemas" / "settings.json").read_text("utf-8"))["settings"]}
    defaults = {f.name: f.default for f in fields(Settings)}
    for key, field in FIELDS.items():
        assert "worker" in catalog[key]["readBy"], key
        want = defaults[field]
        got = catalog[key]["default"]
        if isinstance(want, bool):
            assert got == str(want).lower(), key
        elif isinstance(want, (int, float)):
            assert float(got) == float(want), key
        else:
            assert got == want, key
