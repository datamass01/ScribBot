"""Check that the speech-to-text engine loads and how fast it runs: `python -m scribworker.check [clip.wav]`.

Uses STT_ENGINE (whistle or whisper) and, for Whisper, WHISPER_MODEL / WHISPER_DEVICE /
WHISPER_COMPUTE_TYPE from .env. The first run downloads the weights.
"""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path

from .config import load_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    s = load_settings()
    from .transcribe import load_audio, make_transcriber

    t0 = time.perf_counter()
    tr = make_transcriber(s)
    print(f"loaded {tr.model_name} on {getattr(tr, 'device', 'cpu')} in {time.perf_counter() - t0:.1f}s")

    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
        audio_s = len(load_audio(path)) / 16000
        t0 = time.perf_counter()
        segs, lang = tr.transcribe_file(path, language=s.language, keywords=[])
        took = time.perf_counter() - t0
        print(f"transcribed {audio_s:.1f}s of audio in {took:.2f}s ({audio_s / max(took, 1e-6):.0f}x realtime), language={lang}")
        for seg in segs:
            print(f"  [{seg.start:6.2f}-{seg.end:6.2f}] ({seg.probability:.2f}) {seg.text}")


if __name__ == "__main__":
    main()
