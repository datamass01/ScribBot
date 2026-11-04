"""Round-trip editing of .env: only changed values are rewritten.

Comments, blank lines, order, unknown keys and inline comments stay as they are. A key that isn't
in the file yet goes after the nearest key that precedes it in .env.example, so it lands in the
right section. Writes are atomic (.env.tmp, then rename) and keep the previous file as .env.bak.

Values are written so that both readers agree on them: the bot (Node dotenv) and the worker
(python-dotenv). Both expand escapes such as \\n inside double quotes but take single-quoted values
literally, so a value that needs quoting is single-quoted, unless it contains a single quote.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

_LINE = re.compile(r"^(?P<lead>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=(?P<rest>.*)$")


class EnvValueError(ValueError):
    """A value that can't be written to .env safely."""


@dataclass
class _Entry:
    index: int  # line number in the file
    key: str
    lead: str
    comment: str  # an inline " # comment" after an unquoted value, kept on rewrite


def _split_value(rest: str) -> tuple[str, str]:
    """(value as read, trailing inline comment) of the text after '=', the way parse_env_file reads it."""
    raw = rest.strip()
    if len(raw) >= 2 and raw[0] in "\"'":
        end = raw.find(raw[0], 1)
        if end > 0:
            return raw[1:end], ""
    if " #" in raw:
        value = raw.split(" #", 1)[0].rstrip()
        return value, raw[len(value):]  # the comment with the spacing before it, as written
    return raw, ""


def format_value(value: str) -> str:
    """How `value` is written after KEY=. Raises EnvValueError for values .env can't hold."""
    if "\n" in value or "\r" in value or "\x00" in value:
        raise EnvValueError("must be a single line")
    plain = value == value.strip() and "#" not in value and not value[:1] in ("'", '"', "`") and "$" not in value
    if plain:
        return value
    if "'" not in value:
        return f"'{value}'"
    if '"' not in value and "\\" not in value and "$" not in value:
        return f'"{value}"'
    raise EnvValueError("can't contain both a single quote and a double quote, backslash or $")


class EnvFile:
    def __init__(self, path: Path, example: Path | None = None):
        self.path = path
        self.example = example

    # ---- reading

    def text(self) -> str:
        try:
            # newline="": keep CRLF line endings as written, so a save keeps them.
            with self.path.open(encoding="utf-8-sig", newline="") as f:
                return f.read()
        except FileNotFoundError:
            return ""

    def exists(self) -> bool:
        return self.path.exists()

    def version(self) -> str:
        """Changes whenever the file does; a save names the version it was based on."""
        return hashlib.sha256(self.text().encode("utf-8")).hexdigest()[:16]

    def values(self) -> dict[str, str]:
        """KEY → value, the last occurrence winning (as both dotenv readers do)."""
        out: dict[str, str] = {}
        for line in self.text().splitlines():
            if line.lstrip().startswith("#"):
                continue
            m = _LINE.match(line)
            if m:
                out[m["key"]] = _split_value(m["rest"])[0]
        return out

    def _entries(self, lines: list[str]) -> list[_Entry]:
        out = []
        for i, line in enumerate(lines):
            if line.lstrip().startswith("#"):
                continue
            m = _LINE.match(line)
            if m:
                out.append(_Entry(i, m["key"], m["lead"], _split_value(m["rest"])[1]))
        return out

    def _example_order(self) -> list[str]:
        if not self.example:
            return []
        try:
            text = self.example.read_text(encoding="utf-8-sig")
        except OSError:
            return []
        return [m["key"] for line in text.splitlines() if not line.lstrip().startswith("#") and (m := _LINE.match(line))]

    # ---- writing

    def render(self, changes: dict[str, str]) -> str:
        """The file's text with `changes` applied (nothing written)."""
        text = self.text()
        newline = "\r\n" if "\r\n" in text else "\n"
        lines = text.splitlines()
        ends_with_newline = text.endswith(("\n", "\r"))
        formatted = {key: format_value(value) for key, value in changes.items()}

        present = {e.key for e in self._entries(lines)}
        for e in self._entries(lines):
            if e.key in formatted:
                lines[e.index] = f"{e.lead}{e.key}={formatted[e.key]}{e.comment}"

        order = self._example_order()
        for key in [k for k in changes if k not in present]:
            line = f"{key}={formatted[key]}"
            # After the closest key that comes before it in .env.example and is in this file.
            anchor = None
            if key in order:
                for before in reversed(order[: order.index(key)]):
                    hits = [e.index for e in self._entries(lines) if e.key == before]
                    if hits:
                        anchor = hits[-1]
                        break
            if anchor is None:
                if lines and lines[-1].strip():
                    lines.append("")
                lines.append(line)
            else:
                lines.insert(anchor + 1, line)
            present.add(key)
        return newline.join(lines) + (newline if ends_with_newline or not text else "")

    def save(self, changes: dict[str, str], expected_version: str | None = None) -> None:
        """Applies `changes` atomically. Refuses if the file changed since `expected_version` was read."""
        if expected_version is not None and expected_version != self.version():
            raise EnvValueError(".env was changed by something else since this page loaded it. Reload and try again.")
        new = self.render(changes)
        tmp = self.path.with_name(self.path.name + ".tmp")
        _write_private(tmp, new)
        if self.path.exists():
            bak = self.path.with_name(self.path.name + ".bak")
            shutil.copy2(self.path, bak)
            restrict_to_owner(bak)
        os.replace(tmp, self.path)

    def create_from_example(self) -> None:
        if self.path.exists():
            raise EnvValueError(".env already exists.")
        if not self.example or not self.example.exists():
            raise EnvValueError(".env.example is missing.")
        with open(self.example, encoding="utf-8", newline="") as f:  # byte for byte, BOM and line endings included
            _write_private(self.path, f.read())


# ---------------------------------------------------------------- permissions
#
# .env holds the Discord token, the API token, the Foundry password and API keys, so the files the
# Console writes (.env, .env.tmp, .env.bak) are readable by their owner only: mode 0600 on macOS and
# Linux, and on Windows an ACL with inheritance removed that grants the current user and SYSTEM.
# A filesystem that can't hold permissions (FAT, some network shares) is logged, not an error.


def _write_private(path: Path, text: str) -> None:
    """Writes `text` to `path`, readable by the owner only from the moment it exists (POSIX)."""
    if os.name == "posix":
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    else:
        path.write_text(text, encoding="utf-8", newline="")
    restrict_to_owner(path)


def restrict_to_owner(path: Path, run: Callable[..., Any] = subprocess.run) -> bool:
    """Limits `path` to its owner. False (and a log line) if that couldn't be done."""
    try:
        if os.name == "posix":
            os.chmod(path, 0o600)
            return True
        sid = _current_user_sid(run)
        if not sid:
            raise OSError("couldn't find the current user's SID")
        result = run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid}:(F)", "*S-1-5-18:(F)"],
            capture_output=True, text=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            raise OSError((result.stdout or result.stderr or f"icacls exited {result.returncode}").strip())
        return True
    except (OSError, subprocess.SubprocessError) as err:
        from .monitoring import log

        log(f"couldn't limit {path.name} to your user account: {err}")
        return False


_sid_cache: list[str] = []


def _current_user_sid(run: Callable[..., Any]) -> str | None:
    """The SID of the user running the Console (Windows), from `whoami /user`."""
    if not _sid_cache:
        result = run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=15,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        # "machine\\user","S-1-5-21-…"
        match = re.search(r'"(S-1-[0-9-]+)"', result.stdout or "")
        if result.returncode != 0 or not match:
            return None
        _sid_cache.append(match.group(1))
    return _sid_cache[0]
