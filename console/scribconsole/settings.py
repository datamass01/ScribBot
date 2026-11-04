"""The Configuration tab: shared/schemas/settings.json (generated from the bot's settings catalog)
applied to .env. Secrets are write-only: the page learns whether one is set, never its value."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .envfile import EnvFile, EnvValueError, format_value

CATALOG_FILE = Path(__file__).resolve().parents[2] / "shared" / "schemas" / "settings.json"
_URL = re.compile(r"^https?://[^\s/]+(/\S*)?$")
_TRUE = {"1", "true", "yes", "on"}
# RFC 9110 token, as bot/src/summarize/api-options.ts checks it.
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_FALSE = {"0", "false", "no", "off"}


def _headers_problem(value: str) -> str | None:
    """LLM_HEADERS as the bot reads it: "Name: value" pairs split on ';', or a JSON object of strings.
    Messages name the entry, never its value (a header may hold a key)."""
    text = value.strip()
    if text.startswith("{"):
        try:
            obj = json.loads(text)
        except ValueError:
            return "starts with { but isn't valid JSON"
        if not isinstance(obj, dict):
            return "must be a JSON object"
        pairs = list(obj.items())
        for name, v in pairs:
            if not isinstance(v, (str, int, float)) or isinstance(v, bool):
                return f"the value of {name} must be text"
    else:
        pairs = []
        for i, part in enumerate((p.strip() for p in text.split(";")), 1):
            if not part:
                continue
            name, colon, v = part.partition(":")
            if not colon or not name.strip():
                return f'entry {i} isn\'t "Name: value"'
            pairs.append((name.strip(), v.strip()))
    for name, _ in pairs:
        if not _HEADER_NAME.match(name):
            return f'"{name}" isn\'t a valid header name'
    return None


def _options_problem(value: str) -> str | None:
    """LLM_REQUEST_OPTIONS: a JSON object of extra request-body fields."""
    try:
        obj = json.loads(value)
    except ValueError as err:
        return f"isn't valid JSON ({err.msg} at character {err.pos + 1})"
    return None if isinstance(obj, dict) else "must be a JSON object, e.g. {\"temperature\": 0.3}"


def load_catalog(path: Path = CATALOG_FILE) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


class SettingsError(ValueError):
    def __init__(self, problems: dict[str, str]):
        super().__init__("; ".join(f"{k}: {v}" for k, v in problems.items()))
        self.problems = problems


def restart_needed_by(setting: dict[str, Any]) -> list[str]:
    """Processes that must restart to see a change: those that read it at startup, except the bot
    for a `live` setting, which it re-reads from .env for each summary."""
    return [p for p in setting["readBy"] if not (p == "bot" and setting.get("live"))]


def check_value(setting: dict[str, Any], value: str) -> str | None:
    """Why `value` isn't valid for `setting`, or None. A blank value always means "the default"."""
    if value == "":
        return None
    try:
        format_value(value)
    except EnvValueError as err:
        return str(err)
    kind = setting["type"]
    if kind in ("int", "number"):
        try:
            number = float(value)
        except ValueError:
            return "must be a number"
        if kind == "int" and not number.is_integer():
            return "must be a whole number"
        if "min" in setting and number < setting["min"]:
            return f"must be at least {setting['min']:g}"
        if "max" in setting and number > setting["max"]:
            return f"must be at most {setting['max']:g}"
    elif kind == "bool":
        if value.strip().lower() not in _TRUE | _FALSE:
            return "must be true or false"
    elif kind == "enum":
        allowed = [o["value"] for o in setting.get("options", [])]
        if value not in allowed:
            return "must be one of " + ", ".join(a or "(blank)" for a in allowed)
    elif kind == "url":
        if not _URL.match(value):
            return "must be an http:// or https:// address"
    elif setting["key"] == "LLM_HEADERS":
        return _headers_problem(value)
    elif setting["key"] == "LLM_REQUEST_OPTIONS":
        return _options_problem(value)
    elif kind == "string" and setting["key"] == "FOUNDRY_ORIGINS":
        bad = [o for o in (x.strip() for x in value.split(",")) if o and not _URL.match(o)]
        if bad:
            return f"not a web address: {bad[0]}"
    return None


def warnings_for(setting: dict[str, Any], value: str) -> list[str]:
    """The setting's speed/accuracy/safety warnings that apply to `value` (blank = the default)."""
    effective = value if value != "" else setting["default"]
    out = []
    for w in setting.get("warnings", []):
        when = w["when"]
        if "eq" in when and effective.strip().lower() == str(when["eq"]).lower():
            out.append(w["text"])
            continue
        try:
            number = float(effective)
        except ValueError:
            continue
        if ("gt" in when and number > when["gt"]) or ("lt" in when and number < when["lt"]):
            out.append(w["text"])
    return out


@dataclass
class SaveResult:
    changed: list[str]
    restart: list[str]  # processes that read a changed key
    warnings: dict[str, list[str]] = field(default_factory=dict)


class Settings:
    def __init__(self, env: EnvFile, catalog: dict[str, Any] | None = None, environ: dict[str, str] | None = None):
        self.env = env
        self.catalog = catalog or load_catalog()
        self.by_key = {s["key"]: s for s in self.catalog["settings"]}
        # Like dotenv, a variable already in the environment wins over .env (for every process
        # started from this environment), so the form shows it read-only.
        self.environ = os.environ if environ is None else environ

    def view(self) -> dict[str, Any]:
        """The catalog plus each setting's current value: what the page renders. No secret values."""
        file_values = self.env.values()
        values: dict[str, Any] = {}
        for s in self.catalog["settings"]:
            key = s["key"]
            in_file = key in file_values
            raw = file_values.get(key, "")
            overridden = key in self.environ and self.environ[key] != raw
            entry: dict[str, Any] = {"inFile": in_file, "overridden": overridden}
            shown = self.environ[key] if overridden else raw
            if s["type"] == "secret":
                entry["set"] = bool(shown)
                # Blank or still the example value (API_TOKEN=change-me); says nothing else about it.
                entry["isDefault"] = shown in ("", s["default"])
            else:
                entry["value"] = shown
            entry["warnings"] = [] if s["type"] == "secret" else warnings_for(s, shown)
            values[key] = entry
        unknown = sorted(k for k in file_values if k not in self.by_key and k not in self.catalog.get("legacy", []))
        return {
            "envExists": self.env.exists(),
            "envPath": str(self.env.path),
            "version": self.env.version(),
            "groups": self.catalog["groups"],
            "settings": self.catalog["settings"],
            "values": values,
            "unknownKeys": unknown,
        }

    def save(self, changes: dict[str, Any], version: str | None) -> SaveResult:
        """`changes`: KEY → new value (a string; "" or None resets to the default). Validates everything first."""
        problems: dict[str, str] = {}
        clean: dict[str, str] = {}
        for key, value in changes.items():
            setting = self.by_key.get(key)
            if setting is None:
                problems[key] = "not a ScribBot setting"
                continue
            if value is None:
                value = ""
            if not isinstance(value, str):
                problems[key] = "must be text"
                continue
            if key in self.environ and self.environ[key] != self.env.values().get(key, ""):
                problems[key] = "set in the environment, which wins over .env; change it there"
                continue
            value = value.strip()
            why = check_value(setting, value)
            if why:
                problems[key] = why
            else:
                clean[key] = value
        if problems:
            raise SettingsError(problems)
        current = self.env.values()
        changed = [k for k, v in clean.items() if current.get(k, "") != v]
        if changed:
            self.env.save({k: clean[k] for k in changed}, expected_version=version)
        restart = sorted({p for k in changed for p in restart_needed_by(self.by_key[k])})
        warnings = {k: w for k in changed if self.by_key[k]["type"] != "secret" and (w := warnings_for(self.by_key[k], clean[k]))}
        return SaveResult(changed=changed, restart=restart, warnings=warnings)
