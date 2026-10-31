from __future__ import annotations

import json
import time
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from scribworker.models import Transcript
from scribworker.server import create_app
from scribworker.transcribe import SpeechSegment, is_noise, transcribe_clip, transcribe_session, words_to_segments


class FakeTranscriber:
    """Returns canned segments per clip filename, and counts calls."""

    model_name = "fake"
    device = "cpu"

    def __init__(self, by_file: dict[str, list[WhisperSegment]]):
        self.by_file = by_file
        self.calls: list[str] = []

    def transcribe_file(self, path: Path, *, language, keywords):
        self.calls.append(path.name)
        return self.by_file.get(path.name, []), "en"


def write_wav(path: Path, seconds: float = 0.5) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00\x00" * int(48000 * seconds))


@pytest.fixture
def session(tmp_path: Path) -> Path:
    d = tmp_path / "sessions" / "s1"
    clips = [
        ("1", 12_000, "audio/1/000012000.wav"),
        ("2", 5_000, "audio/2/000005000.wav"),
        ("1", 30_000, "audio/1/000030000.wav"),
    ]
    for _, _, f in clips:
        write_wav(d / f)
    timeline = {
        "sessionId": "s1",
        "guildId": "g",
        "channelId": "c",
        "startedAt": "2026-01-01T18:00:00Z",
        "endedAt": "2026-01-01T21:00:00Z",
        "sampleRate": 48000,
        "channels": 1,
        "participants": [
            {"discordId": "1", "displayName": "Alice", "character": "Thorin", "actorId": "a1", "isGm": False},
            {"discordId": "2", "displayName": "Bob", "character": None, "actorId": None, "isGm": True},
        ],
        "segments": [{"discordId": who, "startMs": ms, "endMs": ms + 500, "file": f} for who, ms, f in clips],
    }
    (d / "timeline.json").write_text(json.dumps(timeline))
    return d


CANNED = {
    "000005000.wav": [SpeechSegment(0.2, 2.0, " The goblin snarls.")],
    "000012000.wav": [
        SpeechSegment(0.0, 1.5, " Stand aside!"),
        SpeechSegment(1.6, 3.0, " Or taste my axe."),
    ],
    "000030000.wav": [SpeechSegment(0.0, 0.4, " mmhm", probability=0.2)],
}


def test_offsets_ordering_and_labels(session: Path):
    t = transcribe_session(session, FakeTranscriber(CANNED), language="en", keywords=[])
    assert [(l.t, l.speaker, l.text) for l in t.lines] == [
        (5.2, "Bob", "The goblin snarls."),
        (12.0, "Alice", "Stand aside!"),
        (13.6, "Alice", "Or taste my axe."),
    ]
    assert t.lines[1].character == "Thorin"
    assert t.lines[0].isGm

    saved = Transcript.model_validate_json((session / "transcript.json").read_text())
    assert saved.lines == t.lines
    md = (session / "transcript.md").read_text()
    assert "**[00:00:05] GM (Bob):** The goblin snarls." in md
    assert "**[00:00:12] Thorin (Alice):** Stand aside! Or taste my axe." in md
    assert not (session / "transcript.partial.jsonl").exists()


def test_resumes_from_partial_cache(session: Path):
    cached = {"file": "audio/2/000005000.wav", "segments": [{"start": 0.0, "end": 1.0, "text": "cached line", "probability": 0.9}]}
    (session / "transcript.partial.jsonl").write_text(json.dumps(cached) + "\n")
    fake = FakeTranscriber(CANNED)
    t = transcribe_session(session, fake, language="en", keywords=[])
    assert "000005000.wav" not in fake.calls
    assert t.lines[0].text == "cached line"


def test_noise_filter():
    assert not is_noise(SpeechSegment(0, 1, " Thank you.", probability=0.9))
    assert is_noise(SpeechSegment(0, 1, " mumble", probability=0.2))
    assert is_noise(SpeechSegment(0, 1, "   "))
    assert is_noise(SpeechSegment(0, 1, " ... "))


def test_words_split_on_pauses_and_long_monologues():
    w = lambda word, start, end, p=0.9: {"word": word, "start": start, "end": end, "probability": p}
    segs = words_to_segments([w("Stand", 0.0, 0.3), w("aside!", 0.3, 0.8), w("Or", 2.5, 2.7, 0.5), w("else.", 2.7, 3.0, 0.7)])
    assert [(s.start, s.end, s.text) for s in segs] == [(0.0, 0.8, "Stand aside!"), (2.5, 3.0, "Or else.")]
    assert segs[1].probability == 0.6

    monologue = [w(f"w{i}", i * 0.5, i * 0.5 + 0.4) for i in range(100)]  # 50 s, no pauses
    lengths = [s.end - s.start for s in words_to_segments(monologue)]
    assert len(lengths) == 2 and max(lengths) <= 30.5


def test_api_runs_job_and_rejects_outside_paths(session: Path, tmp_path: Path):
    app = create_app(transcriber_factory=lambda: FakeTranscriber(CANNED), data_dir=tmp_path, default_language="en")
    client = TestClient(app)

    assert client.post("/jobs/transcribe", json={"sessionDir": str(tmp_path.parent)}).status_code == 400
    assert client.post("/jobs/transcribe", json={"sessionDir": str(session), "language": "ja"}).status_code == 400

    job = client.post("/jobs/transcribe", json={"sessionDir": str(session), "keywords": ["Thorin"]}).json()
    for _ in range(100):
        status = client.get(f"/jobs/{job['id']}").json()
        if status["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert status["status"] == "done", status
    assert status["lines"] == 3
    assert client.get("/health").json()["ok"]


def test_load_audio_resamples_48k_to_16k(tmp_path: Path):
    import numpy as np

    from scribworker.transcribe import load_audio

    rate = 48000
    t = np.arange(rate) / rate  # 1 s
    tone = (0.5 * np.sin(2 * np.pi * 440 * t) * 32767).astype("<i2")
    path = tmp_path / "tone.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(tone.tobytes())

    audio = load_audio(path)
    assert audio.dtype == np.float32
    assert len(audio) == 16000
    # The 440 Hz tone survives the low-pass at about its original amplitude.
    assert 0.45 < np.abs(audio[1000:-1000]).max() < 0.55


def test_live_clip_then_delete_then_finish_from_cache(session: Path):
    fake = FakeTranscriber(CANNED)
    clip = session / "audio/1/000012000.wav"

    segs = transcribe_clip(session, "audio/1/000012000.wav", fake, language="en", keywords=[], delete_audio=True)
    assert [s.text for s in segs] == [" Stand aside!", " Or taste my axe."]
    assert not clip.exists()  # deleted once its text was saved
    # Repeating the request (e.g. a retry) neither re-runs the model nor fails.
    transcribe_clip(session, "audio/1/000012000.wav", fake, language="en", keywords=[], delete_audio=True)
    assert fake.calls == ["000012000.wav"]

    t = transcribe_session(session, fake, language="en", keywords=[], delete_audio=True)
    assert [l.text for l in t.lines] == ["The goblin snarls.", "Stand aside!", "Or taste my axe."]
    assert sorted(fake.calls) == ["000005000.wav", "000012000.wav", "000030000.wav"]  # live clip not redone
    assert not list(session.rglob("*.wav"))
    assert not (session / "transcript.partial.jsonl").exists()


def test_missing_audio_without_transcript_is_an_error(session: Path):
    (session / "audio/2/000005000.wav").unlink()
    with pytest.raises(FileNotFoundError, match="no audio and no saved transcript"):
        transcribe_session(session, FakeTranscriber(CANNED), language="en", keywords=[])
    assert not (session / "transcript.json").exists()  # never overwrite a good transcript with a partial one


def test_api_live_clips_rejects_paths_outside_the_session(session: Path, tmp_path: Path):
    app = create_app(transcriber_factory=lambda: FakeTranscriber(CANNED), data_dir=tmp_path, default_language="en")
    client = TestClient(app)
    bad = client.post("/clips/transcribe", json={"sessionDir": str(session), "file": "../../escape.wav"})
    assert bad.status_code == 400
    ok = client.post(
        "/clips/transcribe",
        json={"sessionDir": str(session), "file": "audio/1/000012000.wav", "deleteAudio": True},
    )
    assert ok.status_code == 202
    for _ in range(100):
        if client.get("/health").json()["liveClips"]["done"] == 1:
            break
        time.sleep(0.05)
    assert not (session / "audio/1/000012000.wav").exists()
