"""The Configuration tab's rules, against the real generated catalog and .env.example."""

from __future__ import annotations

import json

import pytest

from scribconsole.envfile import EnvFile
from scribconsole.monitoring import REPO_ROOT
from scribconsole.settings import Settings, SettingsError, check_value, load_catalog, warnings_for

CATALOG = load_catalog()
BY_KEY = {s["key"]: s for s in CATALOG["settings"]}


def make(tmp_path, text="", environ=None):
    (tmp_path / ".env").write_text(text, "utf-8")
    return Settings(EnvFile(tmp_path / ".env", REPO_ROOT / ".env.example"), CATALOG, environ or {})


def test_every_value_in_the_template_is_valid():
    env = EnvFile(REPO_ROOT / ".env.example")
    for key, value in env.values().items():
        if key in BY_KEY:
            assert check_value(BY_KEY[key], value) is None, (key, value)


def test_secrets_never_reach_the_page(tmp_path):
    s = make(tmp_path, "DISCORD_TOKEN=very-secret\nAPI_TOKEN=change-me\nANTHROPIC_API_KEY=\n")
    view = s.view()
    assert "very-secret" not in json.dumps(view)
    assert view["values"]["DISCORD_TOKEN"] == {"inFile": True, "overridden": False, "set": True, "isDefault": False, "warnings": []}
    assert view["values"]["API_TOKEN"]["isDefault"] is True
    assert view["values"]["ANTHROPIC_API_KEY"]["set"] is False


@pytest.mark.parametrize(("key", "value", "problem"), [
    ("API_PORT", "seventy", "number"),
    ("API_PORT", "70000", "at most"),
    ("WHISPER_BEAM_SIZE", "2.5", "whole number"),
    ("STT_ENGINE", "deepgram", "one of"),
    ("AUTO_SUMMARIZE", "maybe", "true or false"),
    ("WORKER_URL", "localhost:7421", "http"),
    ("FOUNDRY_ORIGINS", "http://ok.example, nope", "nope"),
    ("DISCORD_TOKEN", "a\nb", "single line"),
])
def test_bad_values_are_refused_and_nothing_is_written(tmp_path, key, value, problem):
    s = make(tmp_path, "API_PORT=7420\n")
    with pytest.raises(SettingsError) as err:
        s.save({key: value, "API_HOST": "127.0.0.1"}, None)
    assert problem in err.value.problems[key]
    assert (tmp_path / ".env").read_text("utf-8") == "API_PORT=7420\n"


def test_unknown_keys_are_refused(tmp_path):
    with pytest.raises(SettingsError):
        make(tmp_path).save({"PATH": "C:\\evil"}, None)


def test_save_reports_which_processes_need_a_restart(tmp_path):
    s = make(tmp_path, "WHISPER_BEAM_SIZE=5\nAUTO_SUMMARIZE=false\n")
    r = s.save({"WHISPER_BEAM_SIZE": "8", "AUTO_SUMMARIZE": "false", "LLM_MODEL": "x"}, s.env.version())
    assert r.changed == ["WHISPER_BEAM_SIZE", "LLM_MODEL"]  # AUTO_SUMMARIZE didn't change
    assert r.restart == ["bot", "console", "worker"]
    assert r.warnings["WHISPER_BEAM_SIZE"][0].startswith("Wider beams")


def test_tuned_settings_warn_about_slow_values():
    vad = BY_KEY["WHISPER_VAD"]
    assert warnings_for(vad, "false") and not warnings_for(vad, "true") and not warnings_for(vad, "")
    hot = BY_KEY["WHISPER_MAX_HOTWORDS"]
    assert warnings_for(hot, "60") and not warnings_for(hot, "30")
    assert BY_KEY["WHISPER_VAD"]["tuned"] and BY_KEY["WHISPER_VAD"]["advanced"]


def test_a_variable_from_the_environment_is_read_only(tmp_path):
    s = make(tmp_path, "LLM_MODEL=a\n", environ={"LLM_MODEL": "from-env"})
    assert s.view()["values"]["LLM_MODEL"] == {"inFile": True, "overridden": True, "value": "from-env", "warnings": []}
    with pytest.raises(SettingsError, match="environment"):
        s.save({"LLM_MODEL": "b"}, None)


def test_blank_resets_to_the_default(tmp_path):
    s = make(tmp_path, "WHISPER_BEAM_SIZE=8\n")
    s.save({"WHISPER_BEAM_SIZE": None}, None)
    assert s.env.values()["WHISPER_BEAM_SIZE"] == ""
