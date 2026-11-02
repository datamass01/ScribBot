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
from dataclasses import dataclass
from pathlib import Path

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
        tmp.write_text(new, encoding="utf-8", newline="")
        if self.path.exists():
            shutil.copy2(self.path, self.path.with_name(self.path.name + ".bak"))
        os.replace(tmp, self.path)

    def create_from_example(self) -> None:
        if self.path.exists():
            raise EnvValueError(".env already exists.")
        if not self.example or not self.example.exists():
            raise EnvValueError(".env.example is missing.")
        shutil.copyfile(self.example, self.path)
