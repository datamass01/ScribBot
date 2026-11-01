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


def test_api_runs_job_and_rejects_outside_paths(session: Path, tmp_path: Path, monkeypatch):
    monkeypatch.setenv("STT_ENGINE", "whistle")  # "ja" is outside Whistle's languages; don't depend on the real .env
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


def _line(t, who, text, character=None, gm=False, did=None):
    from scribworker.models import TranscriptLine

    return TranscriptLine(t=t, end=t + 2, discordId=did or who, speaker=who, character=character, isGm=gm, text=text)


def test_markdown_is_self_contained_for_any_llm():
    from scribworker.models import Timeline
    from scribworker.transcribe import render_markdown

    transcript = Transcript(
        sessionId="s1",
        model="cactus-whistle",
        language="en",
        createdAt="2026-11-01T00:00:00+00:00",
        lines=[
            _line(1, "Bob", "The bridge sways.", gm=True),
            _line(9, "Alice", "Stand aside.", character="Thorin"),
            _line(11, "Alice", "Or taste my axe.", character="Thorin"),
            _line(20, "Dave|Jr", "Can I join?"),
        ],
    )
    timeline = Timeline(
        sessionId="s1", guildId="g", channelId="c", startedAt="2026-10-31T19:00:00.000Z",
        endedAt="2026-10-31T22:05:00.000Z", sampleRate=16000, channels=1, participants=[], segments=[],
    )
    md = render_markdown(transcript, "Session transcript, 2026-10-31", timeline)

    assert md.startswith("# Session transcript, 2026-10-31\n\n## About this transcript\n")
    assert "started 2026-10-31 19:00 UTC, 3 h 05 min long" in md
    assert "speech-to-text model (`cactus-whistle`, language `en`)" in md
    assert "Expect misheard words" in md
    # Who plays whom, with table-breaking characters escaped.
    assert "| Bob | GM (narration and NPCs) |" in md
    assert "| Alice | Thorin |" in md
    assert r"| Dave\|Jr | no character mapped |" in md
    # Lines keep the established format, joining one speaker's consecutive lines.
    body = md.split("## Transcript\n\n", 1)[1]
    assert "**[00:00:01] GM (Bob):** The bridge sways." in body
    assert "**[00:00:09] Thorin (Alice):** Stand aside. Or taste my axe." in body


def test_markdown_without_timeline_or_speech():
    from scribworker.transcribe import render_markdown

    md = render_markdown(Transcript(sessionId="s", model="m", language=None, createdAt="x", lines=[]), "T")
    assert "## About this transcript" in md and "## Speakers" not in md
    assert "*(No speech was transcribed.)*" in md


# ---------------------------------------------------------------- engine selection (no model downloads)


def test_settings_pick_the_engine_and_validate(monkeypatch):
    from scribworker.config import load_settings

    for k in ("STT_ENGINE", "WHISPER_MODEL", "WHISPER_DEVICE", "WHISPER_COMPUTE_TYPE"):
        monkeypatch.delenv(k, raising=False)
    s = load_settings()
    assert (s.stt_engine, s.whisper_model, s.whisper_device, s.whisper_compute_type) == ("whistle", "large-v3", "cuda", None)

    monkeypatch.setenv("STT_ENGINE", "Whisper")
    monkeypatch.setenv("WHISPER_DEVICE", "CPU")
    monkeypatch.setenv("WHISPER_COMPUTE_TYPE", "int8")
    s = load_settings()
    assert (s.stt_engine, s.whisper_device, s.whisper_compute_type) == ("whisper", "cpu", "int8")

    monkeypatch.setenv("WHISPER_DEVICE", "tpu")
    with pytest.raises(ValueError, match="WHISPER_DEVICE"):
        load_settings()
    monkeypatch.setenv("WHISPER_DEVICE", "cpu")
    monkeypatch.setenv("STT_ENGINE", "kaldi")
    with pytest.raises(ValueError, match="STT_ENGINE"):
        load_settings()


def test_make_transcriber_routes_to_the_chosen_engine(monkeypatch):
    from types import SimpleNamespace

    import scribworker.transcribe as tr

    made = []
    monkeypatch.setattr(tr, "WhisperTranscriber", lambda *a: made.append(("whisper", a)) or "W")
    monkeypatch.setattr(tr, "WhistleTranscriber", lambda *a: made.append(("whistle", a)) or "S")
    base = dict(weights=None, whisper_model="large-v3", whisper_device="cpu", whisper_compute_type=None,
                whisper_beam_size=2, whisper_max_hotwords=10)
    assert tr.make_transcriber(SimpleNamespace(stt_engine="whisper", **base)) == "W"
    assert tr.make_transcriber(SimpleNamespace(stt_engine="whistle", **base)) == "S"
    opts = tr.WhisperOptions(beam_size=2, max_hotwords=10)  # the rest default
    assert made == [("whisper", ("large-v3", "cpu", None, opts)), ("whistle", (None,))]


def test_whisper_segments_use_word_timings_and_fall_back_to_segments():
    from types import SimpleNamespace as NS

    from scribworker.transcribe import whisper_result_to_segments

    w = lambda word, s, e, p=0.9: NS(word=word, start=s, end=e, probability=p)  # noqa: E731
    with_words = [NS(start=0, end=3, text=" Stand aside.", words=[w(" Stand", 0.0, 0.4), w(" aside.", 0.5, 0.9)]),
                  NS(start=3, end=5, text=" Roll.", words=[w(" Roll.", 3.0, 3.4, 0.5)])]
    segs = whisper_result_to_segments(with_words)
    assert [s.text for s in segs] == ["Stand aside.", "Roll."]  # 2.1 s gap splits the line
    assert segs[1].probability == 0.5

    no_words = [NS(start=1.0, end=2.0, text=" Hello there ", words=None), NS(start=2, end=3, text="  ", words=None)]
    assert [(s.start, s.text) for s in whisper_result_to_segments(no_words)] == [(1.0, "Hello there")]


def test_whisper_accepts_its_wider_language_set():
    from scribworker.transcribe import LANGUAGES, supported_languages

    assert supported_languages("whistle") == LANGUAGES
    whisper = supported_languages("whisper")
    if whisper is not None:  # faster-whisper installed
        assert {"en", "ja", "pt"} <= whisper


def test_health_reports_the_configured_engine_before_loading(monkeypatch, tmp_path):
    monkeypatch.setenv("STT_ENGINE", "whisper")
    monkeypatch.setenv("WHISPER_DEVICE", "cpu")
    app = create_app(transcriber_factory=lambda: None, data_dir=tmp_path)
    health = TestClient(app).get("/health").json()
    assert health["engine"] == "whisper"
    assert health["model"] == "whisper-large-v3"
    assert health["device"] == "cpu (not loaded yet)"


def test_settings_for_short_clip_tuning_and_recovery(monkeypatch):
    from scribworker.config import load_settings

    names = ("WHISPER_BEAM_SIZE", "WHISPER_MAX_HOTWORDS", "WHISPER_HOTWORDS_MIN_SECONDS", "WHISPER_VAD",
             "WHISPER_VAD_THRESHOLD", "DELETE_AUDIO_AFTER_TRANSCRIBE", "WORKER_RECOVER_HOURS")
    for k in names:
        monkeypatch.delenv(k, raising=False)
    s = load_settings()
    assert (s.whisper_beam_size, s.whisper_max_hotwords, s.whisper_hotwords_min_seconds, s.whisper_vad,
            s.whisper_vad_threshold, s.delete_audio, s.recover_hours) == (5, 30, 1.5, True, 0.5, True, 12.0)
    for k, v in zip(names, ("2", "0", "3", "off", "0.6", "false", "0")):
        monkeypatch.setenv(k, v)
    s = load_settings()
    assert (s.whisper_beam_size, s.whisper_max_hotwords, s.whisper_hotwords_min_seconds, s.whisper_vad,
            s.whisper_vad_threshold, s.delete_audio, s.recover_hours) == (2, 0, 3.0, False, 0.6, False, 0.0)
    monkeypatch.setenv("WHISPER_BEAM_SIZE", "0")
    with pytest.raises(ValueError, match="WHISPER_BEAM_SIZE"):
        load_settings()
    monkeypatch.setenv("WHISPER_BEAM_SIZE", "lots")
    with pytest.raises(ValueError, match="must be a number"):
        load_settings()


# ---------------------------------------------------------------- short-clip tuning (fake model, no downloads)


def test_hotwords_are_capped_and_skipped_for_short_clips():
    from scribworker.transcribe import WhisperOptions, pick_hotwords

    opts = WhisperOptions(max_hotwords=3, hotwords_min_seconds=1.5)
    names = ["Thorin", "Elara", "Thorin", " ", "Grubnak", "Dragon", "Golem"]
    assert pick_hotwords(names, 4.0, opts) == ["Thorin", "Elara", "Grubnak"]  # party first, duplicates and blanks dropped
    assert pick_hotwords(names, 1.0, opts) == []
    assert pick_hotwords(names, 4.0, WhisperOptions(max_hotwords=0)) == []


def test_new_tokens_scale_with_clip_length():
    from scribworker.transcribe import MAX_NEW_TOKENS, max_new_tokens

    assert max_new_tokens(1.0) == 24
    assert max_new_tokens(10.0) == 96
    assert max_new_tokens(120.0) == MAX_NEW_TOKENS


def make_whisper(monkeypatch, opts, speech: bool):
    import numpy as np

    import scribworker.transcribe as tr
    from types import SimpleNamespace as NS

    calls = []

    class FakeModel:
        def transcribe(self, audio, **kw):
            calls.append(kw)
            words = [NS(word=" Hello.", start=0.0, end=0.5, probability=0.9)]
            return iter([NS(start=0, end=0.5, text=" Hello.", words=words)]), NS(language="en")

    w = object.__new__(tr.WhisperTranscriber)  # skip loading a real model
    w.model, w.model_name, w.device, w.options, w.last_skipped = FakeModel(), "whisper-fake", "cpu", opts, False
    monkeypatch.setattr(tr, "load_audio", lambda path: np.zeros(int(16000 * 3.0), dtype=np.float32))
    monkeypatch.setattr(w, "has_speech", lambda audio: speech)
    return w, calls


def test_vad_skips_silent_clips_without_running_the_model(monkeypatch):
    from scribworker.transcribe import WhisperOptions

    w, calls = make_whisper(monkeypatch, WhisperOptions(), speech=False)
    assert w.transcribe_file(Path("x.wav"), language="en", keywords=["Thorin"]) == ([], "en")
    assert calls == [] and w.last_skipped is True


def test_speech_is_decoded_with_bounded_settings(monkeypatch):
    from scribworker.transcribe import TEMPERATURES, WhisperOptions

    w, calls = make_whisper(monkeypatch, WhisperOptions(beam_size=2, max_hotwords=2), speech=True)
    segs, lang = w.transcribe_file(Path("x.wav"), language="en", keywords=["Thorin", "Elara", "Dragon"])
    assert [s.text for s in segs] == ["Hello."] and lang == "en" and w.last_skipped is False
    kw = calls[0]
    assert (kw["beam_size"], kw["hotwords"], kw["max_new_tokens"], tuple(kw["temperature"])) == (2, "Thorin, Elara", 40, TEMPERATURES)
    assert kw["vad_filter"] is True and kw["condition_on_previous_text"] is False


def test_vad_can_be_turned_off(monkeypatch):
    from scribworker.transcribe import WhisperOptions

    w, calls = make_whisper(monkeypatch, WhisperOptions(vad=False), speech=False)
    w.transcribe_file(Path("x.wav"), language="en", keywords=[])
    assert len(calls) == 1 and calls[0]["vad_filter"] is False and calls[0]["vad_parameters"] is None


# ---------------------------------------------------------------- pause, resume, recovery, metrics


def wait_for(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_pause_holds_the_queue_and_resume_releases_it(session: Path, tmp_path: Path):
    fake = FakeTranscriber(CANNED)
    client = TestClient(create_app(transcriber_factory=lambda: fake, data_dir=tmp_path, default_language="en"))
    assert client.post("/pause").status_code == 422  # a JSON body is required (no cross-site form posts)
    assert client.post("/pause", json={"reason": "boss fight"}).json()["paused"] is True
    client.post("/clips/transcribe", json={"sessionDir": str(session), "file": "audio/1/000012000.wav"})
    time.sleep(0.3)
    health = client.get("/health").json()
    assert (health["paused"], health["pausedReason"], health["queued"], fake.calls) == (True, "boss fight", 1, [])
    assert client.post("/resume", json={}).json()["paused"] is False
    assert wait_for(lambda: client.get("/health").json()["liveClips"]["done"] == 1)
    assert client.get("/health").json()["paused"] is False


def test_health_reports_per_clip_timing(session: Path, tmp_path: Path):
    client = TestClient(create_app(transcriber_factory=lambda: FakeTranscriber(CANNED), data_dir=tmp_path, default_language="en"))
    for f in ("audio/1/000012000.wav", "audio/1/000030000.wav"):
        client.post("/clips/transcribe", json={"sessionDir": str(session), "file": f})
    assert wait_for(lambda: client.get("/health").json()["liveClips"]["done"] == 2)
    stats = client.get("/health").json()["stats"]
    assert stats["clips"] == 2 and stats["avgAudioSeconds"] == 0.5
    assert stats["keptPct"] == 50  # the "mmhm" clip is all noise
    assert stats["skippedByVad"] == 0 and stats["avgSeconds"] >= 0


def test_a_restarted_worker_requeues_untranscribed_clips(session: Path, tmp_path: Path):
    import os

    old = time.time() - 600
    for wav in session.rglob("*.wav"):
        os.utime(wav, (old, old))
    cached = {"file": "audio/2/000005000.wav", "segments": [{"start": 0.0, "end": 1.0, "text": "already done", "probability": 0.9}]}
    (session / "transcript.partial.jsonl").write_text(json.dumps(cached) + "\n")
    # Still being written by the bot: too fresh to touch.
    write_wav(session / "audio/1/000099000.wav")
    # Finished sessions are left alone.
    done = tmp_path / "sessions" / "s0"
    write_wav(done / "audio/1/000001000.wav")
    (done / "transcript.json").write_text("{}")

    fake = FakeTranscriber(CANNED)
    client = TestClient(create_app(transcriber_factory=lambda: fake, data_dir=tmp_path, default_language="en", recover=True))
    assert client.get("/health").json()["recovered"] == {"sessions": 1, "clips": 2}
    assert wait_for(lambda: client.get("/health").json()["liveClips"]["done"] == 2)
    assert sorted(fake.calls) == ["000012000.wav", "000030000.wav"]


def test_unfinished_clips_respects_the_age_limit(session: Path, tmp_path: Path):
    from scribworker.transcribe import unfinished_clips

    later = time.time() + 3 * 3600  # three hours after the session was last touched
    assert len(unfinished_clips(tmp_path, 12, now=later)) == 3
    assert unfinished_clips(tmp_path, 2, now=later) == []
    assert unfinished_clips(tmp_path, 0, now=later) == []


def test_unfinished_clips_never_opens_timeline_json(session: Path, tmp_path: Path, monkeypatch):
    from scribworker.transcribe import unfinished_clips

    opened = []
    real = Path.read_text
    monkeypatch.setattr(Path, "read_text", lambda self, *a, **k: opened.append(self.name) or real(self, *a, **k))
    unfinished_clips(tmp_path, 12, now=time.time() + 600)
    assert "timeline.json" not in opened


def test_glossary_names_match_the_bot():
    from scribworker.transcribe import glossary_names

    assert glossary_names("<!-- note -->\n# Heading\n- Thorin: dwarf\n* Elara\nGrubnak\n") == ["Thorin", "Elara", "Grubnak"]


def test_preload_reports_a_model_that_fails_to_load(tmp_path):
    def broken():
        raise RuntimeError("WHISPER_DEVICE=cuda but no CUDA GPU was found.")

    client = TestClient(create_app(transcriber_factory=broken, data_dir=tmp_path, preload=True))
    deadline = time.time() + 5
    while time.time() < deadline and client.get("/health").json()["loadError"] is None:
        time.sleep(0.05)
    assert "no CUDA GPU" in client.get("/health").json()["loadError"]


def test_preload_loads_the_model_on_the_transcription_thread(tmp_path):
    import threading

    seen = []

    class Fake:
        model_name = "fake"
        device = "cpu"

        def __init__(self):
            seen.append(threading.current_thread().name)

    client = TestClient(create_app(transcriber_factory=Fake, data_dir=tmp_path, preload=True))
    deadline = time.time() + 5
    while time.time() < deadline and client.get("/health").json()["model"] != "fake":
        time.sleep(0.05)
    health = client.get("/health").json()
    assert (health["model"], health["loadError"]) == ("fake", None)
    assert seen == ["transcriber"]
