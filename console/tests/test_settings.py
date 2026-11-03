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
    ("ANTHROPIC_BASE_URL", "api.example.com", "http"),
    ("LLM_HEADERS", "x-api-key sk-secret", "entry 1"),
    ("LLM_HEADERS", "Bad Name: v", "valid header name"),
    ("LLM_HEADERS", '{"x-api-key": sk-secret}', "valid JSON"),
    ("LLM_HEADERS", '{"A": {"b": 1}}', "must be text"),
    ("LLM_REQUEST_OPTIONS", "temperature=0.3", "valid JSON"),
    ("LLM_REQUEST_OPTIONS", "[1, 2]", "JSON object"),
    ("DISCORD_TOKEN", "a\nb", "single line"),
])
def test_bad_values_are_refused_and_nothing_is_written(tmp_path, key, value, problem):
    s = make(tmp_path, "API_PORT=7420\n")
    with pytest.raises(SettingsError) as err:
        s.save({key: value, "API_HOST": "127.0.0.1"}, None)
    assert problem in err.value.problems[key]
    assert (tmp_path / ".env").read_text("utf-8") == "API_PORT=7420\n"


def test_header_problems_never_quote_the_value(tmp_path):
    for value in ("x-api-key sk-secret", '{"x-api-key": sk-secret}'):
        with pytest.raises(SettingsError) as err:
            make(tmp_path).save({"LLM_HEADERS": value}, None)
        assert "sk-secret" not in str(err.value)


def test_freeform_api_settings_are_written_as_given(tmp_path):
    s = make(tmp_path, "")
    headers = "HTTP-Referer: https://example.org; X-Title: ScribBot"
    options = '{"temperature": 0.3, "provider": {"order": ["anthropic"]}}'
    s.save({"LLM_HEADERS": headers, "LLM_REQUEST_OPTIONS": options, "XAI_BASE_URL": "https://eu.api.x.ai/v1"}, None)
    text = (tmp_path / ".env").read_text("utf-8")
    assert f"LLM_HEADERS={headers}" in text
    assert f"LLM_REQUEST_OPTIONS={options}" in text
    assert "XAI_BASE_URL=https://eu.api.x.ai/v1" in text


def test_unknown_keys_are_refused(tmp_path):
    with pytest.raises(SettingsError):
        make(tmp_path).save({"PATH": "C:\\evil"}, None)


def test_save_reports_which_processes_need_a_restart(tmp_path):
    s = make(tmp_path, "WHISPER_BEAM_SIZE=5\nAUTO_SUMMARIZE=false\n")
    r = s.save({"WHISPER_BEAM_SIZE": "8", "AUTO_SUMMARIZE": "false", "LLM_MODEL": "x"}, s.env.version())
    assert r.changed == ["WHISPER_BEAM_SIZE", "LLM_MODEL"]  # AUTO_SUMMARIZE didn't change
    assert r.restart == ["console", "worker"]  # LLM_MODEL is live for the bot
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


def test_live_settings_need_no_bot_restart(tmp_path):
    from scribconsole.settings import restart_needed_by

    assert "bot" not in restart_needed_by(BY_KEY["LLM_PROVIDER"])  # re-read for each summary
    assert "bot" in restart_needed_by(BY_KEY["DISCORD_TOKEN"])  # read once, at startup
    s = make(tmp_path, "LLM_PROVIDER=anthropic\n")
    r = s.save({"LLM_PROVIDER": "claude-code", "LLM_CLI_PATH": "C:/tools/claude.exe"}, s.env.version())
    assert "bot" not in r.restart
