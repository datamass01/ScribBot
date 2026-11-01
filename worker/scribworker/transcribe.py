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


# What Whisper "hears" in near-silence (docs/assessment/01 R9). Compared after lowercasing and
# stripping punctuation, so "Thank you." and "thank you!" match.
FILLER_PHRASES = frozenset({
    "thank you", "thank you very much", "thank you so much", "thanks", "thanks for watching",
    "thank you for watching", "thanks for watching and see you next time", "you", "bye", "bye bye",
    "the end", "okay", "ok", "so", "oh", "uh", "um", "hmm", "mm", "yeah",
})


def _normalize(text: str) -> str:
    return " ".join("".join(c if c.isalnum() or c.isspace() else " " for c in text.lower()).split())


def is_filler(segs: list[SpeechSegment], seconds: float, max_seconds: float, max_probability: float) -> bool:
    """True when the whole clip is a stock silence phrase, short, and decoded without confidence.

    All three must hold: a real "thank you" usually scores higher or comes in a longer clip.
    """
    if max_seconds <= 0 or seconds >= max_seconds or not segs:
        return False
    texts = [_normalize(s.text) for s in segs if s.text.strip()]
    if not texts or not all(t in FILLER_PHRASES for t in texts):
        return False
    mean = sum(s.probability for s in segs) / len(segs)
    return mean < max_probability


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


def _md_cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def _label(line: TranscriptLine) -> str:
    if line.isGm:
        return f"GM ({line.speaker})"
    return f"{line.character} ({line.speaker})" if line.character else line.speaker


def _duration(seconds: float) -> str:
    m = int(max(0, seconds)) // 60
    return f"{m // 60} h {m % 60:02d} min" if m >= 60 else f"{m} min"


def render_markdown(transcript: Transcript, title: str, timeline: Timeline | None = None) -> str:
    """Self-contained Markdown transcript that any LLM (or person) can read without other files.

    An "About" section explains what the file is and how it was made, a table says who plays
    whom, then consecutive lines from one speaker are joined into paragraphs.
    """
    out = [f"# {title}", "", "## About this transcript", ""]
    when = ""
    if timeline is not None:
        when = f", started {timeline.startedAt[:16].replace('T', ' ')} UTC"
        if timeline.endedAt:
            try:
                secs = (datetime.fromisoformat(timeline.endedAt.replace("Z", "+00:00"))
                        - datetime.fromisoformat(timeline.startedAt.replace("Z", "+00:00"))).total_seconds()
                when += f", {_duration(secs)} long"
            except ValueError:
                pass
    language = f", language `{transcript.language}`" if transcript.language else ""
    out += [
        f"- A tabletop role-playing game session recorded on Discord voice chat{when}.",
        f"- Transcribed automatically by a speech-to-text model (`{transcript.model}`{language}). "
        "Expect misheard words, especially fantasy names, and some missing or merged lines.",
        "- Each line reads `[HH:MM:SS] Character (Player): what they said`, timed from the start of the session. "
        "Speakers without a mapped character appear by their Discord name.",
        "- The GM's lines include narration and the voices of non-player characters.",
        "",
    ]

    speakers: dict[str, TranscriptLine] = {}
    for line in transcript.lines:
        speakers.setdefault(line.discordId, line)
    if speakers:
        out += ["## Speakers", "", "| Player | Plays |", "|---|---|"]
        for line in speakers.values():
            plays = "GM (narration and NPCs)" if line.isGm else (line.character or "no character mapped")
            out.append(f"| {_md_cell(line.speaker)} | {_md_cell(plays)} |")
        out.append("")

    out += ["## Transcript", ""]
    if not transcript.lines:
        out += ["*(No speech was transcribed.)*", ""]
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


SEGMENT_JOURNAL = "timeline.segments.jsonl"


def load_timeline(session_dir: Path) -> Timeline:
    """timeline.json plus any clips only the bot's append-only journal lists (docs/assessment/02 S10).

    The bot snapshots timeline.json every ~30 s but journals each clip at once, so after a crash the
    journal can be ahead. Segments are unioned by file; a torn last journal line is skipped.
    """
    timeline = Timeline.model_validate_json((session_dir / "timeline.json").read_text("utf-8"))
    journal = session_dir / SEGMENT_JOURNAL
    if not journal.exists():
        return timeline
    by_file = {seg.file: seg for seg in timeline.segments}
    for raw in journal.read_text("utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            seg = Segment.model_validate_json(raw)
        except ValueError:
            continue
        by_file.setdefault(seg.file, seg)
    return timeline.model_copy(update={"segments": sorted(by_file.values(), key=lambda x: x.startMs)})


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
    timeline = load_timeline(session_dir)
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
    (session_dir / "transcript.md").write_text(render_markdown(transcript, f"Session transcript, {started}", timeline), "utf-8")
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


def _add_nvidia_dll_dirs() -> None:
    """Let CTranslate2 find cuBLAS/cuDNN from the nvidia-* pip wheels.

    Those wheels put their DLLs in site-packages/nvidia/<lib>/bin, which Windows doesn't search.
    """
    if os.name != "nt":
        return
    import glob
    import site

    bases = {*site.getsitepackages(), site.getusersitepackages()}
    for base in bases:
        for d in glob.glob(os.path.join(base, "nvidia", "*", "bin")):
            os.add_dll_directory(d)
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


@dataclass(frozen=True)
class WhisperOptions:
    """Decoding settings for the many short clips a session produces (see docs/assessment/01)."""

    beam_size: int = 5
    max_hotwords: int = 30  # 0: never send hotwords
    hotwords_min_seconds: float = 1.5  # shorter clips get none: on near-silence Whisper "reads out" the list
    vad: bool = True
    vad_threshold: float = 0.5
    filler_max_seconds: float = 2.0  # 0: keep every filler phrase
    filler_max_probability: float = 0.7


# Fewer, cooler retries than faster-whisper's default 0.0→1.0 in six steps: on junk clips each
# retry is another full beam search, and hot temperatures mostly produce more junk.
TEMPERATURES = (0.0, 0.4, 0.8)
# Speech rarely exceeds ~4 tokens a second; leave slack, and stay well inside Whisper's 448-token
# window, which the hotword prompt also uses.
TOKENS_PER_SECOND = 8
TOKEN_SLACK = 16
MAX_NEW_TOKENS = 200


def pick_hotwords(keywords: list[str], seconds: float, opts: WhisperOptions) -> list[str]:
    if opts.max_hotwords <= 0 or seconds < opts.hotwords_min_seconds:
        return []
    return list(dict.fromkeys(k for k in keywords if k.strip()))[: opts.max_hotwords]


def max_new_tokens(seconds: float) -> int:
    return min(MAX_NEW_TOKENS, int(seconds * TOKENS_PER_SECOND) + TOKEN_SLACK)


class WhisperTranscriber:
    """OpenAI's Whisper (default large-v3) through faster-whisper, on an NVIDIA GPU or the CPU.

    Like Whistle, it is used from the server's single transcription thread. Silero VAD (on the CPU,
    via onnxruntime) screens every clip first, so silent ones never reach the model.
    """

    def __init__(
        self,
        model: str = "large-v3",
        device: str = "cuda",
        compute_type: str | None = None,
        options: WhisperOptions | None = None,
    ) -> None:
        compute = compute_type or ("float16" if device == "cuda" else "int8")
        if device == "cuda":
            _add_nvidia_dll_dirs()
            import ctranslate2

            if ctranslate2.get_cuda_device_count() == 0:
                raise RuntimeError(
                    "WHISPER_DEVICE=cuda but no CUDA GPU was found. Update the NVIDIA driver, or set WHISPER_DEVICE=cpu."
                )
        from faster_whisper import WhisperModel

        # First use downloads the weights from Hugging Face (about 3 GB for large-v3).
        self.model = WhisperModel(model, device=device, compute_type=compute)
        self.model_name = f"whisper-{model}"
        self.device = f"{device} ({compute})"
        self.options = options or WhisperOptions()
        self.last_skipped = False  # read by the server's metrics after each call
        self.last_filler = False
        log.info("loaded Whisper %s on %s (%s)", model, self.device, self.options)

    def has_speech(self, audio) -> bool:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        return bool(get_speech_timestamps(audio, VadOptions(threshold=self.options.vad_threshold)))

    def transcribe_file(
        self, path: Path, *, language: str | None, keywords: list[str]
    ) -> tuple[list[SpeechSegment], str | None]:
        audio = load_audio(path)
        seconds = len(audio) / SAMPLE_RATE
        self.last_filler = False
        self.last_skipped = self.options.vad and not self.has_speech(audio)
        if self.last_skipped:
            return [], language
        hotwords = pick_hotwords(keywords, seconds, self.options)
        segments, info = self.model.transcribe(
            audio,
            language=language,
            beam_size=self.options.beam_size,
            temperature=list(TEMPERATURES),
            max_new_tokens=max_new_tokens(seconds),
            word_timestamps=True,
            # Campaign names, the way Whistle's keyword biasing gets them.
            hotwords=", ".join(hotwords) if hotwords else None,
            # Each clip is one speech burst; carrying text over between clips invites repetition.
            condition_on_previous_text=False,
            # Trims silence around the speech the screen above found.
            vad_filter=self.options.vad,
            vad_parameters={"threshold": self.options.vad_threshold} if self.options.vad else None,
        )
        result = whisper_result_to_segments(list(segments))
        o = self.options
        if is_filler(result, seconds, o.filler_max_seconds, o.filler_max_probability):
            self.last_filler = True
            log.debug("dropped filler %r from %s", " / ".join(x.text for x in result), path.name)
            return [], info.language or None
        return result, info.language or None


def whisper_result_to_segments(segments: list) -> list[SpeechSegment]:
    """faster-whisper segments → our lines, using word timings where present."""
    words = [
        {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
        for s in segments
        for w in (getattr(s, "words", None) or [])
    ]
    if words:
        return words_to_segments(words)
    return [SpeechSegment(start=s.start, end=s.end, text=s.text.strip()) for s in segments if s.text.strip()]


def supported_languages(engine: str) -> set[str] | None:
    """Language codes the engine accepts; None means "let the model decide"."""
    if engine == "whistle":
        return LANGUAGES
    try:
        from faster_whisper.tokenizer import _LANGUAGE_CODES

        return set(_LANGUAGE_CODES)
    except ImportError:
        return None


def make_transcriber(settings) -> Transcriber:
    """The engine STT_ENGINE picks: Whistle (default) or Whisper."""
    if settings.stt_engine == "whisper":
        return WhisperTranscriber(
            settings.whisper_model, settings.whisper_device, settings.whisper_compute_type, whisper_options(settings)
        )
    return WhistleTranscriber(settings.weights)


def whisper_options(settings) -> WhisperOptions:
    return WhisperOptions(
        beam_size=getattr(settings, "whisper_beam_size", 5),
        max_hotwords=getattr(settings, "whisper_max_hotwords", 30),
        hotwords_min_seconds=getattr(settings, "whisper_hotwords_min_seconds", 1.5),
        vad=getattr(settings, "whisper_vad", True),
        vad_threshold=getattr(settings, "whisper_vad_threshold", 0.5),
        filler_max_seconds=getattr(settings, "whisper_filler_max_seconds", 2.0),
        filler_max_probability=getattr(settings, "whisper_filler_max_probability", 0.7),
    )


# ---------------------------------------------------------------- recovery after a restart

# A clip the bot is still writing changes every 20 ms; anything untouched this long is finished.
SETTLED_SECONDS = 120


def glossary_names(text: str) -> list[str]:
    """Same rule as the bot's glossaryNames(): each list item or line, up to any ':' note."""
    import re

    names = []
    for line in re.sub(r"<!--[\s\S]*?-->", "", text).splitlines():
        if line.strip().startswith("#"):
            continue
        name = re.sub(r"^\s*[-*]\s*", "", line).split(":")[0].strip()
        if name and len(name) <= 40:
            names.append(name)
    return names


def unfinished_clips(data_root: Path, max_age_hours: float, now: float | None = None) -> list[tuple[Path, str]]:
    """(session dir, clip file) for audio that was recorded but never transcribed, oldest first.

    Only the session folders and the worker's own cache are read. timeline.json is deliberately not
    opened: the bot may be recording into it, and on Windows its rename-over fails while another
    process holds the file open (docs/assessment/02 S1). A WAV still being written is skipped by age.
    """
    import time

    if max_age_hours <= 0:
        return []
    now = time.time() if now is None else now
    found: list[tuple[Path, str]] = []
    sessions = data_root / "sessions"
    if not sessions.is_dir():
        return []
    for d in sorted(p for p in sessions.iterdir() if p.is_dir()):
        audio = d / "audio"
        if (d / "transcript.json").exists() or not audio.is_dir():
            continue
        try:
            if now - max(audio.stat().st_mtime, d.stat().st_mtime) > max_age_hours * 3600:
                continue
            done = read_cache(d)
            wavs = sorted(audio.glob("*/*.wav"), key=lambda p: (p.stem, p.parent.name))  # by start time
            for wav in wavs:
                rel = wav.relative_to(d).as_posix()
                if rel not in done and now - wav.stat().st_mtime >= SETTLED_SECONDS:
                    found.append((d, rel))
        except OSError:
            continue  # a folder being deleted
    return found
