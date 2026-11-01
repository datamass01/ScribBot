"""Daily worker log files in DATA_DIR/logs (docs/assessment/02 S9), named like the bot's."""

from __future__ import annotations

import logging
import re

from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 20 * 1024 * 1024  # per file; a busier day continues in worker-<day>.1.log, .2…


class DailyFileHandler(logging.Handler):
    """Writes `<prefix>-YYYY-MM-DD.log` (UTC day), starting a new file each day and pruning old ones."""

    def __init__(self, directory: Path, prefix: str = "worker", retention_days: float = 14, now=None) -> None:
        super().__init__()
        self.directory = Path(directory)
        self.prefix = prefix
        self.retention_days = retention_days
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.day = ""
        self.part = 0
        self.stream = None

    def _path(self) -> Path:
        suffix = f".{self.part}" if self.part else ""
        return self.directory / f"{self.prefix}-{self.day}{suffix}.log"

    def _open(self, day: str) -> None:
        if self.stream:
            self.stream.close()
        self.directory.mkdir(parents=True, exist_ok=True)
        if day != self.day:
            self.day, self.part = day, 0
            self.prune()
        while self._path().exists() and self._path().stat().st_size > MAX_BYTES:
            self.part += 1
        self.stream = self._path().open("a", encoding="utf-8")

    def emit(self, record: logging.LogRecord) -> None:
        try:
            day = self.now().strftime("%Y-%m-%d")
            if day != self.day or self.stream is None:
                self._open(day)
            elif self.stream.tell() > MAX_BYTES:
                self.part += 1
                self._open(day)
            self.stream.write(self.format(record) + "\n")
            self.stream.flush()
        except Exception:  # noqa: BLE001 - logging must never take the worker down
            self.handleError(record)

    def prune(self) -> None:
        cutoff = self.now().timestamp() - self.retention_days * 86400
        pattern = re.compile(rf"^{re.escape(self.prefix)}-(\d{{4}}-\d{{2}}-\d{{2}})(\.\d+)?\.log$")
        for f in self.directory.glob(f"{self.prefix}-*.log"):
            m = pattern.match(f.name)
            if not m:
                continue
            day_end = datetime.strptime(m.group(1), "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() + 86399
            if day_end < cutoff:
                try:
                    f.unlink()
                except OSError:
                    pass

    def close(self) -> None:
        if self.stream:
            self.stream.close()
            self.stream = None
        super().close()


__all__ = ["DailyFileHandler"]
