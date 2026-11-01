"""Worker fixes from docs/assessment: the segment journal (02 S10), the filler filter (01 R9),
queue priorities (02 S5), model reload (02 S7) and log files (02 S9)."""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from scribworker.logfile import DailyFileHandler
from scribworker.server import MeteredTranscriber, create_app
from scribworker.transcribe import SpeechSegment, is_filler, load_timeline, transcribe_session

from test_transcribe import CANNED, FakeTranscriber, session, write_wav  # noqa: F401 - fixture


# ---------------------------------------------------------------- S10: segment journal


def test_load_timeline_adds_journal_only_clips_and_skips_a_torn_line(session: Path):
    write_wav(session / "audio/2/000040000.wav")
    journal = session / "timeline.segments.jsonl"
    journal.write_text(
        json.dumps({"discordId": "1", "startMs": 12_000, "endMs": 13_000, "file": "audio/1/000012000.wav"}) + "\n"
        + json.dumps({"discordId": "2", "startMs": 40_000, "endMs": 41_000, "file": "audio/2/000040000.wav"}) + "\n"
        + '{"discordId": "2", "startMs": 5',  # crash mid-append
        "utf-8",
    )
    timeline = load_timeline(session)
    assert [s.file for s in timeline.segments] == [
        "audio/2/000005000.wav", "audio/1/000012000.wav", "audio/1/000030000.wav", "audio/2/000040000.wav",
    ]
    fake = FakeTranscriber(CANNED)
    transcribe_session(session, fake, language="en", keywords=[])
    assert "000040000.wav" in fake.calls  # the journal-only clip is transcribed too


# ---------------------------------------------------------------- R9: filler phrases


def seg(text: str, p: float) -> SpeechSegment:
    return SpeechSegment(start=0.0, end=0.5, text=text, probability=p)


def test_filler_needs_a_stock_phrase_a_short_clip_and_low_confidence():
    assert is_filler([seg(" Thank you.", 0.4)], 1.0, 2.0, 0.7)
    assert is_filler([seg("Bye!", 0.5), seg("you", 0.3)], 1.5, 2.0, 0.7)
    assert not is_filler([seg("Thank you.", 0.9)], 1.0, 2.0, 0.7)  # confident: a real thanks
    assert not is_filler([seg("Thank you.", 0.4)], 3.0, 2.0, 0.7)  # long clip
    assert not is_filler([seg("Thank you, Thorin.", 0.4)], 1.0, 2.0, 0.7)  # more than the phrase
    assert not is_filler([seg("Thank you.", 0.4)], 1.0, 0.0, 0.7)  # disabled
    assert not is_filler([], 1.0, 2.0, 0.7)


# ---------------------------------------------------------------- S5: priorities


class BlockingTranscriber(FakeTranscriber):
    """Holds the first call until released, so the queue order behind it can be checked."""

    def __init__(self) -> None:
        super().__init__({})
        self.gate = threading.Event()

    def transcribe_file(self, path, *, language, keywords):
        if not self.calls:
            self.calls.append(path.name)
            self.gate.wait(5)
            return [], "en"
        return super().transcribe_file(path, language=language, keywords=keywords)


def wait_for(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_live_clips_run_before_a_job_for_an_old_session(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("STT_ENGINE", "whistle")
    fake = BlockingTranscriber()
    client = TestClient(create_app(transcriber_factory=lambda: fake, data_dir=tmp_path, default_language="en"))

    old = tmp_path / "sessions" / "old"
    live = tmp_path / "sessions" / "live"
    write_wav(old / "audio/1/000001000.wav")
    (old / "timeline.json").write_text(json.dumps({
        "sessionId": "old", "guildId": "g", "channelId": "c", "startedAt": "2026-01-01T18:00:00Z", "endedAt": None,
        "sampleRate": 16000, "channels": 1, "participants": [],
        "segments": [{"discordId": "1", "startMs": 1000, "endMs": 1500, "file": "audio/1/000001000.wav"}],
    }), "utf-8")
    for name in ("000000001.wav", "000000002.wav", "000000003.wav"):
        write_wav(live / "audio/9" / name)

    first = {"sessionDir": str(live), "file": "audio/9/000000001.wav"}
    assert client.post("/clips/transcribe", json=first).status_code == 202
    assert wait_for(lambda: fake.calls == ["000000001.wav"])  # the thread is now blocked on it
    client.post("/jobs/transcribe", json={"sessionDir": str(old)})
    client.post("/clips/transcribe", json={"sessionDir": str(live), "file": "audio/9/000000002.wav"})
    client.post("/clips/transcribe", json={"sessionDir": str(live), "file": "audio/9/000000003.wav"})
    fake.gate.set()
    assert wait_for(lambda: len(fake.calls) == 4)
    assert fake.calls == ["000000001.wav", "000000002.wav", "000000003.wav", "000001000.wav"]


# ---------------------------------------------------------------- S7: model reload


class BrokenModel(FakeTranscriber):
    def transcribe_file(self, path, *, language, keywords):
        self.calls.append(path.name)
        raise RuntimeError("CUDA error: an illegal memory access was encountered")


def test_metered_transcriber_flags_a_broken_model_but_not_bad_files(tmp_path: Path):
    health: dict = {}
    m = MeteredTranscriber(BrokenModel({}), stats=__import__("collections").deque(), health=health, reload_after=3)
    clip = tmp_path / "a.wav"
    write_wav(clip)
    for _ in range(2):
        try:
            m.transcribe_file(clip, language=None, keywords=[])
        except RuntimeError:
            pass
    assert not health.get("broken")
    try:
        m.transcribe_file(clip, language=None, keywords=[])
    except RuntimeError:
        pass
    assert health["broken"] and health["consecutive_failures"] == 3

    class MissingFile(FakeTranscriber):
        def transcribe_file(self, path, *, language, keywords):
            raise FileNotFoundError(path)

    health2: dict = {}
    m2 = MeteredTranscriber(MissingFile({}), stats=__import__("collections").deque(), health=health2, reload_after=1)
    try:
        m2.transcribe_file(clip, language=None, keywords=[])
    except FileNotFoundError:
        pass
    assert not health2.get("broken")


def test_worker_reloads_the_model_after_repeated_errors(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("STT_ENGINE", "whistle")
    monkeypatch.setenv("WORKER_RELOAD_AFTER_FAILURES", "2")
    made: list[FakeTranscriber] = []

    def factory():
        t = BrokenModel({}) if not made else FakeTranscriber(CANNED)
        made.append(t)
        return t

    client = TestClient(create_app(transcriber_factory=factory, data_dir=tmp_path, default_language="en"))
    live = tmp_path / "sessions" / "live"
    for name in ("000000001.wav", "000000002.wav", "000000003.wav"):
        write_wav(live / "audio/9" / name)
        client.post("/clips/transcribe", json={"sessionDir": str(live), "file": f"audio/9/{name}"})
    assert wait_for(lambda: client.get("/health").json()["liveClips"]["done"] == 1)
    h = client.get("/health").json()
    assert h["modelReloads"] == 1 and h["liveClips"]["failed"] == 2 and len(made) == 2
    assert h["consecutiveFailures"] == 0


# ---------------------------------------------------------------- S9: log files


def test_daily_log_handler_writes_per_day_and_prunes(tmp_path: Path):
    now = [datetime(2026, 11, 1, 12, tzinfo=timezone.utc)]
    old = tmp_path / "worker-2026-10-01.log"
    old.write_text("old\n")
    keep = tmp_path / "scribbot-2026-10-01.log"  # the monitor's files aren't ours to prune
    keep.write_text("x\n")
    h = DailyFileHandler(tmp_path, "worker", 14, now=lambda: now[0])
    h.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger("test-daily")
    logger.addHandler(h)
    logger.setLevel(logging.INFO)
    logger.info("first")
    now[0] += timedelta(days=1)
    logger.info("second")
    h.close()
    logger.removeHandler(h)
    assert (tmp_path / "worker-2026-11-01.log").read_text() == "first\n"
    assert (tmp_path / "worker-2026-11-02.log").read_text() == "second\n"
    assert not old.exists() and keep.exists()
