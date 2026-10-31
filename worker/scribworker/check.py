"""Check that Whistle loads and how fast it runs: `python -m scribworker.check [clip.wav]`."""

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
    from .transcribe import WhistleTranscriber, load_audio

    t0 = time.perf_counter()
    tr = WhistleTranscriber(s.weights)
    print(f"loaded Whistle in {time.perf_counter() - t0:.1f}s")

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
