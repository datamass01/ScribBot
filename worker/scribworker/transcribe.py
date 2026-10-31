"""Turn a recorded session folder (timeline.json + per-speaker WAV clips) into transcript.json."""

from __future__ import annotations

import json
import os
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from .models import Participant, Segment, Timeline, Transcript, TranscriptLine

log = logging.getLogger("scribworker")

SAMPLE_RATE = 16_000  # what Whistle expects
LANGUAGES = {"en", "de", "fr", "es", "it", "nl", "pl"}

# A pause this long inside one clip starts a new transcript line.
LINE_GAP_S = 1.2
# Long monologues are cut into lines of at most this length.
MAX_LINE_S = 30.0
# Clips whose words average below this confidence are almost always noise.
MIN_MEAN_PROBABILITY = 0.35


@dataclass
class SpeechSegment:
    start: float
    end: float
    text: str
    probability: float = 1.0


class Transcriber(Protocol):
    """What the pipeline needs from a speech-to-text model; lets tests swap in a fake."""

    model_name: str

    def transcribe_file(
        self, path: Path, *, language: str | None, keywords: list[str]
    ) -> tuple[list[SpeechSegment], str | None]: ...


def is_noise(seg: SpeechSegment) -> bool:
    text = seg.text.strip()
    if not text or not any(c.isalnum() for c in text):
        return True
    return seg.probability < MIN_MEAN_PROBABILITY


def words_to_segments(words: list[dict]) -> list[SpeechSegment]:
    """Group word timestamps into lines, breaking on pauses and at sentence ends past MAX_LINE_S."""
    segments: list[SpeechSegment] = []
    current: list[dict] = []

    def flush() -> None:
        if current:
            probs = [w.get("probability", 1.0) for w in current]
            segments.append(
                SpeechSegment(
                    start=current[0]["start"],
                    end=current[-1]["end"],
                    text=" ".join(w["word"].strip() for w in current).strip(),
                    probability=sum(probs) / len(probs),
                )
            )
            current.clear()

    for w in words:
        if current:
            gap = w["start"] - current[-1]["end"]
            too_long = w["start"] - current[0]["start"] > MAX_LINE_S
            if gap >= LINE_GAP_S or too_long:
                flush()
        current.append(w)
    flush()
    return segments


def clip_lines(clip: Segment, who: Participant, segments: Iterable[SpeechSegment]) -> list[TranscriptLine]:
    """Model times are relative to the clip; shift them onto the session clock."""
    offset = clip.startMs / 1000
    lines = []
    for s in segments:
        if is_noise(s):
            continue
        lines.append(
            TranscriptLine(
                t=round(offset + s.start, 2),
                end=round(offset + s.end, 2),
                discordId=clip.discordId,
                speaker=who.displayName,
                character=who.character,
                isGm=who.isGm,
                text=s.text.strip(),
            )
        )
    return lines


def _fmt(seconds: float) -> str:
    s = int(max(0, seconds))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _label(line: TranscriptLine) -> str:
    if line.isGm:
        return f"GM ({line.speaker})"
    return f"{line.character} ({line.speaker})" if line.character else line.speaker


def render_markdown(transcript: Transcript, title: str) -> str:
    """Readable transcript; consecutive lines from one speaker are joined into a paragraph."""
    out = [f"# {title}", ""]
    prev_id: str | None = None
    prev_end = -1e9
    para: list[str] = []
    header = ""

    def flush() -> None:
        if para:
            out.append(f"{header} {' '.join(para)}")
            out.append("")

    for line in transcript.lines:
        if line.discordId == prev_id and line.t - prev_end < 4:
            para.append(line.text)
        else:
            flush()
            header = f"**[{_fmt(line.t)}] {_label(line)}:**"
            para = [line.text]
        prev_id, prev_end = line.discordId, line.end
    flush()
    return "\n".join(out)


CACHE_NAME = "transcript.partial.jsonl"


def read_cache(session_dir: Path) -> dict[str, dict]:
    """Per-clip results, keyed by clip file. Written as each clip is transcribed (live or at stop)."""
    cache_file = session_dir / CACHE_NAME
    cache: dict[str, dict] = {}
    if cache_file.exists():
        for raw in cache_file.read_text("utf-8").splitlines():
            if raw.strip():
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    continue  # a torn last line from a crash; that clip is simply redone
                cache[entry["file"]] = entry
    return cache


def _append_cache(session_dir: Path, file: str, segs: list[SpeechSegment], language: str | None) -> None:
    entry = {"file": file, "language": language, "segments": [s.__dict__ for s in segs]}
    with (session_dir / CACHE_NAME).open("a", encoding="utf-8") as out:
        out.write(json.dumps(entry) + "\n")
        out.flush()
        os.fsync(out.fileno())  # the text must be on disk before the audio can be deleted


def transcribe_clip(
    session_dir: Path,
    file: str,
    transcriber: Transcriber,
    *,
    language: str | None,
    keywords: list[str],
    delete_audio: bool,
    cache: dict[str, dict] | None = None,
) -> list[SpeechSegment]:
    """Transcribe one clip into the session cache, then optionally delete its WAV. Idempotent."""
    cache = read_cache(session_dir) if cache is None else cache
    path = session_dir / file
    if file in cache:
        segs = [SpeechSegment(**s) for s in cache[file]["segments"]]
    else:
        if not path.exists():
            raise FileNotFoundError(f"clip {file} has no audio and no saved transcript")
        segs, lang = transcriber.transcribe_file(path, language=language, keywords=keywords)
        _append_cache(session_dir, file, segs, lang)
        cache[file] = {"file": file, "language": lang, "segments": [s.__dict__ for s in segs]}
    if delete_audio:
        path.unlink(missing_ok=True)
    return segs


def transcribe_session(
    session_dir: Path,
    transcriber: Transcriber,
    *,
    language: str | None,
    keywords: list[str],
    delete_audio: bool = False,
    on_progress: Callable[[float], None] = lambda _: None,
) -> Transcript:
    """Build transcript.json from every clip in the timeline.

    Clips already transcribed live (or by an interrupted earlier run) come from the cache;
    the rest are transcribed now.
    """
    timeline = Timeline.model_validate_json((session_dir / "timeline.json").read_text("utf-8"))
    people = {p.discordId: p for p in timeline.participants}
    clips = sorted(timeline.segments, key=lambda s: s.startMs)
    cache = read_cache(session_dir)

    lines: list[TranscriptLine] = []
    for n, clip in enumerate(clips):
        who = people.get(clip.discordId) or Participant(discordId=clip.discordId, displayName=clip.discordId)
        segs = transcribe_clip(
            session_dir, clip.file, transcriber,
            language=language, keywords=keywords, delete_audio=delete_audio, cache=cache,
        )
        lines.extend(clip_lines(clip, who, segs))
        on_progress((n + 1) / max(1, len(clips)))
    detected_language = language or next((e["language"] for e in cache.values() if e.get("language")), None)

    lines.sort(key=lambda l: (l.t, l.discordId))
    transcript = Transcript(
        sessionId=timeline.sessionId,
        model=transcriber.model_name,
        language=detected_language,
        createdAt=datetime.now(timezone.utc).isoformat(),
        lines=lines,
    )
    tmp = session_dir / "transcript.json.tmp"
    tmp.write_text(transcript.model_dump_json(indent=2), "utf-8")
    tmp.replace(session_dir / "transcript.json")
    started = timeline.startedAt[:10]
    (session_dir / "transcript.md").write_text(render_markdown(transcript, f"Session transcript, {started}"), "utf-8")
    # transcript.json now holds everything; dropping the cache lets a later run re-transcribe kept audio.
    (session_dir / CACHE_NAME).unlink(missing_ok=True)
    return transcript


def _lowpass_taps(cutoff: float, numtaps: int = 63):
    """Windowed-sinc FIR low-pass; cutoff is a fraction of the sample rate."""
    import numpy as np

    n = np.arange(numtaps) - (numtaps - 1) / 2
    taps = 2 * cutoff * np.sinc(2 * cutoff * n) * np.hamming(numtaps)
    return taps / taps.sum()


def load_audio(path: Path):
    """Read a 16-bit PCM WAV clip as mono float32 samples at 16 kHz, Whistle's input format.

    The bot records at 16 kHz already; older 48 kHz recordings are resampled here.
    """
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as w:
        rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"{path}: expected 16-bit PCM, got {width * 8}-bit")

    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate == SAMPLE_RATE:
        return audio
    if rate % SAMPLE_RATE == 0:
        factor = rate // SAMPLE_RATE
        # Anti-alias just under the new Nyquist frequency, then keep every n-th sample.
        filtered = np.convolve(audio, _lowpass_taps(0.45 / factor), mode="same")
        return filtered[::factor].astype(np.float32)
    duration = len(audio) / rate
    target = np.linspace(0, duration, int(duration * SAMPLE_RATE), endpoint=False)
    return np.interp(target, np.arange(len(audio)) / rate, audio).astype(np.float32)


class WhistleTranscriber:
    """Cactus Compute's Whistle (via the cactus-needle package), loaded once and reused for every clip.

    Whistle runs on the CPU and is not thread-safe; the server calls it from a single thread.
    """

    model_name = "cactus-whistle"
    device = "cpu"

    def __init__(self, weights: str | None = None) -> None:
        import needle

        # First use downloads whistle.cact from Hugging Face (Cactus-Compute/whistle) unless weights are given.
        self.model = needle.Whistle(weights=weights)
        log.info("loaded Whistle from %s", self.model.weights)

    def transcribe_file(
        self, path: Path, *, language: str | None, keywords: list[str]
    ) -> tuple[list[SpeechSegment], str | None]:
        result = self.model.transcribe(
            load_audio(path),
            language=language,
            keywords=keywords or None,
            word_timestamps=True,
        )
        words = result.get("words") or []
        if words:
            segments = words_to_segments(words)
        elif result.get("text", "").strip():
            # No timings came back; keep the text as one line spanning the clip.
            segments = [SpeechSegment(start=0.0, end=0.0, text=result["text"].strip())]
        else:
            segments = []
        return segments, result.get("language") or None
