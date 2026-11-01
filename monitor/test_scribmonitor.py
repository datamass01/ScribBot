"""Tests for the optional web monitor. Hermetic: fake fetchers, temp folders, port 0."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest

import scribmonitor as sm


def make_config(tmp_path: Path, **overrides) -> sm.Config:
    base = dict(
        bot_url="http://127.0.0.1:7420",
        api_token="secret-token",
        worker_url="http://127.0.0.1:7421",
        data_dir=tmp_path,
        llm_provider="anthropic",
        llm_model="claude-opus-5-5",
        llm_credentials=None,
        chunk_minutes=25,
        auto_summarize=False,
        delete_audio=True,
        retention_days=14,
        port=7422,
        campaign_dir=tmp_path / "campaign",
        log_dir=None,
    )
    base.update(overrides)
    return sm.Config(**base)


def fake_fetch(responses: dict[str, object]):
    """Returns a fetch() that answers by URL prefix; an Exception value is raised."""
    calls: list[tuple[str, str | None]] = []

    def fetch(url, token=None, timeout=None):
        calls.append((url, token))
        for prefix, value in responses.items():
            if url.startswith(prefix):
                if isinstance(value, Exception):
                    raise value
                return value
        raise URLError("connection refused")

    fetch.calls = calls
    return fetch


# ---------------------------------------------------------------- configuration


def test_parse_env_file_handles_comments_quotes_and_inline_comments(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        "# comment\n\nAPI_TOKEN=abc123\nLLM_MODEL=\"quoted # not a comment\"\nAPI_PORT=7500 # trailing\nexport DATA_DIR='./x'\nBROKEN LINE\n",
        encoding="utf-8",
    )
    assert sm.parse_env_file(env) == {
        "API_TOKEN": "abc123",
        "LLM_MODEL": "quoted # not a comment",
        "API_PORT": "7500",
        "DATA_DIR": "./x",
    }


def test_parse_env_file_missing_is_empty(tmp_path):
    assert sm.parse_env_file(tmp_path / "nope.env") == {}


def test_config_defaults_and_overrides(tmp_path):
    env = tmp_path / ".env"
    env.write_text("API_HOST=0.0.0.0\nAPI_PORT=7500\nANTHROPIC_API_KEY=sk-test\nMONITOR_PORT=7600\nDELETE_AUDIO_AFTER_TRANSCRIBE=false\n", encoding="utf-8")
    cfg = sm.Config.load(env, environ={"API_TOKEN": "from-environment"})
    assert cfg.bot_url == "http://127.0.0.1:7500"  # 0.0.0.0 is reached via loopback
    assert cfg.api_token == "from-environment"  # real env wins over .env, like dotenv
    assert cfg.llm_credentials == "api key"  # the source, never the key itself
    assert cfg.port == 7600
    assert cfg.delete_audio is False
    assert cfg.worker_url == "http://127.0.0.1:7421"
    assert cfg.llm_model == "claude-opus-5-5"


# ---------------------------------------------------------------- status


def test_status_relays_the_bot_with_its_token(tmp_path):
    fetch = fake_fetch({"http://127.0.0.1:7420/status": {"warnings": [], "sessions": []}})
    data = sm.Monitor(make_config(tmp_path), fetch).status()
    assert data["monitor"]["bot"] == "online"
    assert fetch.calls[0] == ("http://127.0.0.1:7420/status", "secret-token")


def test_status_falls_back_when_the_bot_is_down(tmp_path):
    fetch = fake_fetch({"http://127.0.0.1:7421/health": {"ok": True, "model": "cactus-whistle", "queued": 0}})
    data = sm.Monitor(make_config(tmp_path), fetch).status()
    assert data["monitor"]["bot"] == "offline"
    assert data["worker"]["reachable"] is True and data["worker"]["model"] == "cactus-whistle"
    assert data["discord"] is None and data["recordings"] == []
    assert "isn't answering" in data["warnings"][0]
    # Same top-level shape the dashboard renders.
    for key in ("now", "process", "worker", "llm", "foundry", "config", "disk", "sessions", "warnings"):
        assert key in data
    # The worker isn't sent the API token.
    assert ("http://127.0.0.1:7421/health", None) in fetch.calls


def test_status_explains_a_rejected_token(tmp_path):
    err = HTTPError("http://127.0.0.1:7420/status", 401, "Unauthorized", {}, None)
    fetch = fake_fetch({"http://127.0.0.1:7420/status": err})
    data = sm.Monitor(make_config(tmp_path), fetch).status()
    assert "rejected the API_TOKEN" in data["monitor"]["reason"]


def test_offline_status_warns_about_an_unreachable_worker(tmp_path):
    data = sm.Monitor(make_config(tmp_path), fake_fetch({})).status()
    assert data["worker"]["reachable"] is False
    assert any("worker is unreachable" in w for w in data["warnings"])


def test_offline_status_only_warns_about_llm_setup_when_summarizing_automatically(tmp_path):
    manual = sm.Monitor(make_config(tmp_path), fake_fetch({})).status()
    assert manual["llm"]["autoSummarize"] is False
    assert not any("ANTHROPIC_API_KEY" in w for w in manual["warnings"])
    auto = sm.Monitor(make_config(tmp_path, auto_summarize=True), fake_fetch({})).status()
    assert any("ANTHROPIC_API_KEY" in w for w in auto["warnings"])


def test_config_auto_summarize_defaults_off(tmp_path):
    assert sm.Config.load(tmp_path / "none.env", environ={}).auto_summarize is False
    assert sm.Config.load(tmp_path / "none.env", environ={"AUTO_SUMMARIZE": "true"}).auto_summarize is True


def test_offline_status_warns_when_the_worker_model_failed_to_load(tmp_path):
    fetch = fake_fetch({"http://127.0.0.1:7421/health": {"ok": True, "loadError": "no CUDA GPU was found"}})
    data = sm.Monitor(make_config(tmp_path), fetch).status()
    assert any("failed to load: no CUDA GPU" in w for w in data["warnings"])


# ---------------------------------------------------------------- database


def make_db(data_dir: Path) -> Path:
    db = data_dir / "scribbot.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, text_channel_id TEXT,
          number INTEGER, status TEXT, error TEXT, started_at TEXT, ended_at TEXT, summarized_at TEXT,
          audio_purged INTEGER DEFAULT 0);
        CREATE TABLE roster (foundry_user_id TEXT PRIMARY KEY, user_name TEXT, is_gm INTEGER, actor_id TEXT,
          actor_name TEXT, actor_img TEXT, discord_id TEXT);
        INSERT INTO sessions VALUES ('s1','g','c',NULL,1,'complete',NULL,'2026-10-30T20:00:00Z','2026-10-30T23:00:00Z',NULL,1);
        INSERT INTO sessions VALUES ('s2','g','c',NULL,2,'failed','boom','2026-10-31T20:00:00Z',NULL,NULL,0);
        INSERT INTO roster VALUES ('u1','Ann',0,NULL,NULL,NULL,'123');
        INSERT INTO roster VALUES ('u2','Bob',1,NULL,NULL,NULL,NULL);
        """
    )
    conn.commit()
    conn.close()
    folder = data_dir / "sessions" / "s1"
    folder.mkdir(parents=True)
    (folder / "timeline.json").write_text(json.dumps({"segments": [{}, {}, {}], "participants": [{}, {}]}), encoding="utf-8")
    (folder / "summary.json").write_text("{}", encoding="utf-8")
    return db


def test_read_database_lists_sessions_and_roster_without_writing(tmp_path):
    db = make_db(tmp_path)
    before = db.read_bytes()
    sessions, roster = sm.Monitor(make_config(tmp_path), fake_fetch({})).read_database()
    assert db.read_bytes() == before
    assert [s["number"] for s in sessions] == [2, 1]  # newest first
    s1 = sessions[1]
    assert (s1["clips"], s1["speakers"], s1["hasSummary"], s1["hasTranscript"], s1["audioPurged"]) == (3, 2, True, False, True)
    assert sessions[0]["error"] == "boom" and sessions[0]["clips"] is None
    assert roster == (2, 1)


def test_offline_status_counts_failed_sessions(tmp_path):
    make_db(tmp_path)
    data = sm.Monitor(make_config(tmp_path), fake_fetch({})).status()
    assert any("1 session(s) failed" in w for w in data["warnings"])
    assert data["foundry"]["rosterUsers"] == 2


def test_read_database_without_a_database(tmp_path):
    assert sm.Monitor(make_config(tmp_path), fake_fetch({})).read_database() == ([], (0, 0))


# ---------------------------------------------------------------- pipeline: queue, conversion, shutdown


def write_session(data_dir: Path, sid: str, clips: int, converted: int, transcript: bool = False) -> None:
    folder = data_dir / "sessions" / sid
    folder.mkdir(parents=True, exist_ok=True)
    segs = [{"file": f"audio/u/{i:09d}.wav"} for i in range(clips)]
    (folder / "timeline.json").write_text(json.dumps({"segments": segs, "participants": []}), encoding="utf-8")
    if converted:
        lines = [json.dumps({"file": s["file"], "segments": []}) for s in segs[:converted]]
        lines.append(lines[0])  # a duplicate (an idempotent retry) counts once
        (folder / "transcript.partial.jsonl").write_text("\n".join(lines) + "\n{\"fi", encoding="utf-8")  # torn last line
    if transcript:
        (folder / "transcript.json").write_text("{}", encoding="utf-8")


def bot_status(sessions, recordings=(), queued=0, reachable=True):
    return {
        "warnings": [],
        "recordings": list(recordings),
        "sessions": list(sessions),
        "worker": {"reachable": reachable, "queued": queued},
    }


def session_row(sid, number, status, processing=False, progress=None):
    return {"id": sid, "number": number, "status": status, "processing": processing, "progress": progress, "clips": None}


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_pipeline_reports_live_conversion_and_blocks_shutdown_while_recording(tmp_path):
    # timeline.json says 50, but while the bot records into it the monitor must not open it
    # (Windows rename-over-open-file); the bot's live count of 12 is used instead.
    write_session(tmp_path, "live", clips=50, converted=4)
    status = bot_status(
        [session_row("live", 12, "recording"), session_row("old", 11, "complete")],
        recordings=[{"sessionId": "live", "number": 12, "clips": 12}],
        queued=8,
    )
    fetch = fake_fetch({"http://127.0.0.1:7420/status": status})
    p = sm.Monitor(make_config(tmp_path), fetch).status()["monitor"]["pipeline"]
    assert [c["sessionId"] for c in p["conversions"]] == ["live"]  # finished sessions aren't listed
    c = p["conversions"][0]
    assert (c["phase"], c["converted"], c["clips"], c["pending"]) == ("recording", 4, 12, 8)  # bot's live count wins
    assert p["queue"]["depth"] == 8 and p["queue"]["ratePerMin"] is None  # not enough history yet
    assert p["shutdown"]["state"] == "no" and "/scrib stop" in p["shutdown"]["reasons"][0]


def test_pipeline_measures_rate_trend_and_eta(tmp_path):
    clock = FakeClock()
    write_session(tmp_path, "s", clips=100, converted=10)
    responses = {"http://127.0.0.1:7420/status": bot_status([session_row("s", 3, "transcribing")], queued=90)}
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch(responses), clock=clock)
    monitor.status()
    clock.t += 60
    write_session(tmp_path, "s", clips=100, converted=40)
    responses["http://127.0.0.1:7420/status"] = bot_status([session_row("s", 3, "transcribing", processing=True, progress=0.4)], queued=60)
    p = monitor.status()["monitor"]["pipeline"]
    q = p["queue"]
    assert (q["ratePerMin"], q["trendPerMin"], q["pendingClips"], q["etaSec"]) == (30.0, -30.0, 60, 120)
    assert p["conversions"][0]["phase"] == "finishing"
    sd = p["shutdown"]
    assert sd["state"] == "wait"
    assert "being transcribed (40%, 60 clips left)" in sd["reasons"][0]
    assert "60 clips still waiting" in sd["reasons"][1] and "about 2m" in sd["reasons"][1]


def test_pipeline_history_is_trimmed_to_the_window(tmp_path):
    clock = FakeClock()
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": bot_status([])}), clock=clock)
    for _ in range(5):
        monitor.status()
        clock.t += 200
    assert monitor.status()["monitor"]["pipeline"]["queue"]["windowSec"] <= sm.RATE_WINDOW_S


def test_pipeline_is_safe_when_idle(tmp_path):
    fetch = fake_fetch({"http://127.0.0.1:7420/status": bot_status([session_row("s", 1, "complete")])})
    sd = sm.Monitor(make_config(tmp_path), fetch).status()["monitor"]["pipeline"]["shutdown"]
    assert sd["state"] == "safe" and "queue is empty" in sd["reasons"][0]


def test_pipeline_waits_for_summarizing(tmp_path):
    write_session(tmp_path, "s", clips=5, converted=0, transcript=True)
    fetch = fake_fetch({"http://127.0.0.1:7420/status": bot_status([session_row("s", 4, "summarizing", processing=True)])})
    p = sm.Monitor(make_config(tmp_path), fetch).status()["monitor"]["pipeline"]
    assert (p["conversions"][0]["converted"], p["conversions"][0]["pending"]) == (5, 0)  # transcript.json = all converted
    assert p["shutdown"]["state"] == "wait" and "being summarized" in p["shutdown"]["reasons"][0]


def test_pipeline_with_the_bot_down_checks_the_worker_queue(tmp_path):
    busy = sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7421/health": {"ok": True, "queued": 3}})).status()
    sd = busy["monitor"]["pipeline"]["shutdown"]
    assert sd["state"] == "wait" and "3 clips still waiting in the worker (the bot is already stopped)" in sd["reasons"][0]
    idle = sm.Monitor(make_config(tmp_path), fake_fetch({})).status()["monitor"]["pipeline"]["shutdown"]
    assert idle["state"] == "safe" and "worker isn't running" in idle["reasons"][0]


def test_pipeline_flags_sessions_interrupted_while_the_bot_is_down(tmp_path):
    make_db(tmp_path)
    conn = sqlite3.connect(tmp_path / "scribbot.db")
    conn.execute("UPDATE sessions SET status='recording' WHERE id='s2'")
    conn.commit()
    conn.close()
    p = sm.Monitor(make_config(tmp_path), fake_fetch({})).status()["monitor"]["pipeline"]
    assert p["conversions"][0]["phase"] == "interrupted"
    assert p["shutdown"]["state"] == "safe" and any("/scrib process" in r for r in p["shutdown"]["reasons"])


def test_pipeline_shows_a_failed_session_the_worker_is_recovering(tmp_path):
    # The bot marks a session failed when the worker restarts; the new worker re-queues its clips from disk.
    write_session(tmp_path, "s12", clips=10, converted=6)
    write_session(tmp_path, "old", clips=3, converted=3)
    write_session(tmp_path, "done", clips=3, converted=0, transcript=True)
    old_cache = tmp_path / "sessions" / "old" / sm.CACHE_NAME
    stale = old_cache.stat().st_mtime - sm.FAILED_RECENT_S - 60
    os.utime(old_cache, (stale, stale))
    sessions = [session_row("s12", 12, "failed"), session_row("old", 5, "failed"), session_row("done", 4, "failed")]
    responses = {"http://127.0.0.1:7420/status": bot_status(sessions, queued=4)}
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch(responses))
    p = monitor.status()["monitor"]["pipeline"]
    assert [c["sessionId"] for c in p["conversions"]] == ["s12"]  # not stale caches or finished transcripts
    c = p["conversions"][0]
    assert (c["phase"], c["converted"], c["pending"]) == ("failed", 6, 4)
    alert = next(a for a in p["alerts"] if a["key"] == "failed-s12")
    assert "still converting" in alert["text"] and "/scrib process session:12" in alert["text"]
    assert p["shutdown"]["state"] == "wait" and any("session:12" in r for r in p["shutdown"]["reasons"])

    responses["http://127.0.0.1:7420/status"] = bot_status(sessions, queued=0)
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch(responses))
    p = monitor.status()["monitor"]["pipeline"]
    alert = next(a for a in p["alerts"] if a["key"] == "failed-s12")
    assert "still converting" not in alert["text"] and "Run /scrib process session:12" in alert["text"]
    assert p["shutdown"]["state"] == "safe"


def test_a_second_monitor_cannot_share_the_port(tmp_path):
    first = sm.MonitorServer(("127.0.0.1", 0), sm.make_handler(sm.Monitor(make_config(tmp_path), fake_fetch({}))))
    try:
        with pytest.raises(OSError):
            sm.MonitorServer(("127.0.0.1", first.server_address[1]), sm.make_handler(sm.Monitor(make_config(tmp_path), fake_fetch({}))))
    finally:
        first.server_close()


def test_live_recording_never_opens_timeline_json(tmp_path, monkeypatch):
    write_session(tmp_path, "live", clips=5, converted=2)
    opened = []
    real = Path.read_text

    def spy(self, *a, **k):
        opened.append(self.name)
        return real(self, *a, **k)

    monkeypatch.setattr(Path, "read_text", spy)
    status = bot_status([session_row("live", 1, "recording")], recordings=[{"sessionId": "live", "number": 1, "clips": 5}])
    sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": status})).status()
    assert "timeline.json" not in opened and "transcript.partial.jsonl" in opened


def test_status_is_shared_for_a_moment(tmp_path):
    clock = FakeClock()
    fetch = fake_fetch({"http://127.0.0.1:7420/status": bot_status([])})
    monitor = sm.Monitor(make_config(tmp_path), fetch, clock=clock)
    monitor.status()
    monitor.status()
    assert len(fetch.calls) == 1
    clock.t += sm.STATUS_TTL_S
    monitor.status()
    assert len(fetch.calls) == 2


# ---------------------------------------------------------------- quality and alerts


def write_cache(data_dir: Path, sid: str, texts: list[tuple[str, float]]) -> None:
    folder = data_dir / "sessions" / sid
    folder.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"file": f"audio/u/{i}.wav", "segments": [{"start": 0, "end": 1, "text": t, "probability": p}]})
             for i, (t, p) in enumerate(texts)]
    (folder / "transcript.partial.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_glossary_names_match_the_bot():
    text = "<!-- template note -->\n# Heading\n- Thorin: dwarf\n* Elara\nGrubnak\n\n" + "x" * 41
    assert sm.glossary_names(text) == ["Thorin", "Elara", "Grubnak"]


def test_quality_counts_noise_and_hotword_echoes(tmp_path):
    (tmp_path / "campaign").mkdir()
    (tmp_path / "campaign" / "glossary.md").write_text("- Glabrezu\n- Giant Slug\n", encoding="utf-8")
    (tmp_path / "foundry-actors.json").write_text(json.dumps([{"name": "Dragon"}, {"name": "Golem"}]), encoding="utf-8")
    texts = [("Dragon", 0.2)] * 20 + [("giant slug, glabrezu, golem", 0.9)] * 5 + [("Thank you for watching!", 0.9)] * 3 \
        + [("I open the door and look inside.", 0.9)] * 12
    write_cache(tmp_path, "s", texts)
    status = bot_status([session_row("s", 7, "recording")], recordings=[{"sessionId": "s", "number": 7, "clips": 40, "speakers": []}])
    p = sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": status})).status()["monitor"]["pipeline"]
    q = p["conversions"][0]["quality"]
    assert (q["clips"], q["noise"], q["hallucinations"]) == (40, 20, 28)
    assert q["topRepeats"][0] == {"text": "dragon", "count": 20}
    assert p["hotwords"] == {"count": 4, "fromFoundry": 2}
    assert any(a["key"] == "quality-s" for a in p["alerts"])


def test_alert_when_the_bot_disappears_mid_recording(tmp_path):
    clock = FakeClock()
    write_session(tmp_path, "live", clips=3, converted=1)
    (tmp_path / "sessions" / "live" / "timeline.json.tmp").write_text("{", encoding="utf-8")
    responses = {"http://127.0.0.1:7420/status": bot_status(
        [session_row("live", 12, "recording")], recordings=[{"sessionId": "live", "number": 12, "clips": 3}])}
    responses["http://127.0.0.1:7420/status"]["now"] = "2026-11-01T02:36:00.000Z"
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch(responses), clock=clock)
    monitor.status()
    del responses["http://127.0.0.1:7420/status"]  # bot gone
    clock.t += 5
    data = monitor.status()
    crash = [a for a in data["monitor"]["pipeline"]["alerts"] if a["key"] == "crash"]
    assert crash and "stopped while recording session 12" in crash[0]["text"] and "timeline.json.tmp" in crash[0]["text"]
    assert data["warnings"][0] == crash[0]["text"]  # shown at the top of the page's warnings
    assert data["monitor"]["pipeline"]["crash"]["timelineTmp"] == [12]


def test_alert_when_the_worker_is_stuck(tmp_path):
    clock = FakeClock()
    write_session(tmp_path, "s", clips=10, converted=2)
    status = bot_status([session_row("s", 1, "transcribing")], queued=8)
    status["worker"]["liveClips"] = {"done": 2, "failed": 0}
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": status}), clock=clock)
    monitor.status()
    clock.t += sm.STALL_AFTER_S
    p = monitor.status()["monitor"]["pipeline"]
    assert p["queue"]["stalled"] is True and any(a["key"] == "stalled" for a in p["alerts"])


def test_a_paused_worker_is_not_reported_as_stuck(tmp_path):
    clock = FakeClock()
    write_session(tmp_path, "s", clips=10, converted=2)
    status = bot_status([session_row("s", 1, "transcribing")], queued=8)
    status["worker"].update(paused=True, pausedReason="boss fight", recovered={"sessions": 1, "clips": 8},
                            stats={"clips": 3, "avgSeconds": 0.2})
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": status}), clock=clock)
    monitor.status()
    clock.t += sm.STALL_AFTER_S * 2
    p = monitor.status()["monitor"]["pipeline"]
    keys = {a["key"] for a in p["alerts"]}
    assert "stalled" not in keys and "paused" in keys
    assert (p["queue"]["paused"], p["queue"]["worker"]["avgSeconds"]) == (True, 0.2)
    reason = " ".join(p["shutdown"]["reasons"])
    assert "It is paused" in reason and "re-queues the clips from disk" in reason


def test_alert_when_a_recording_gets_no_audio(tmp_path):
    clock = FakeClock()
    rec = {"sessionId": "live", "number": 3, "clips": 10, "speakers": [{"character": "Thorin"}]}
    status = bot_status([session_row("live", 3, "recording")], recordings=[rec])
    monitor = sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": status}), clock=clock)
    monitor.status()
    clock.t += sm.SILENT_AFTER_S - 1
    assert not any(a["key"].startswith("silent") for a in monitor.status()["monitor"]["pipeline"]["alerts"])
    clock.t += 2
    alerts = monitor.status()["monitor"]["pipeline"]["alerts"]
    assert any(a["key"] == "silent-live" and "lost the voice connection" in a["text"] for a in alerts)


def test_alert_when_transcription_falls_behind(tmp_path):
    clock = FakeClock()
    responses = {}

    def at(clips, queued, converted):
        write_session(tmp_path, "live", clips=converted, converted=converted)
        responses["http://127.0.0.1:7420/status"] = bot_status(
            [session_row("live", 5, "recording")], recordings=[{"sessionId": "live", "number": 5, "clips": clips}], queued=queued)

    monitor = sm.Monitor(make_config(tmp_path), fake_fetch(responses), clock=clock)
    at(100, 50, 1)
    monitor.status()
    clock.t += 120
    at(160, 100, 10)
    alerts = monitor.status()["monitor"]["pipeline"]["alerts"]
    behind = [a for a in alerts if a["key"] == "behind"]
    assert behind and "growing by 25/min" in behind[0]["text"]


def test_alert_when_summaries_would_fail(tmp_path):
    status = bot_status([])
    status["llm"] = {"provider": "openai-compatible", "model": None}
    p = sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": status})).status()["monitor"]["pipeline"]
    assert any(a["key"] == "llm-model" for a in p["alerts"])


# ---------------------------------------------------------------- log file


class Today:
    def __init__(self, d):
        self.d = d

    def __call__(self):
        return self.d


def test_bot_logs_are_copied_once_across_monitor_restarts(tmp_path):
    from datetime import date

    logs = tmp_path / "logs"
    entries = [{"seq": 1, "t": "T1", "level": "info", "msg": "[discord] logged in"},
               {"seq": 2, "t": "T2", "level": "error", "msg": "[recorder] boom"}]
    status = bot_status([])
    status["process"] = {"startedAt": "2026-11-01T01:33:03Z"}
    responses = {"http://127.0.0.1:7420/status": status, "http://127.0.0.1:7420/logs?after=0": entries,
                 "http://127.0.0.1:7420/logs?after=2": []}
    day = Today(date(2026, 10, 31))
    sm.Monitor(make_config(tmp_path), fake_fetch(responses), logfile=sm.LogFile(logs, day)).sample_once()
    sm.Monitor(make_config(tmp_path), fake_fetch(responses), logfile=sm.LogFile(logs, day)).sample_once()  # restarted monitor
    text = (logs / "scribbot-2026-10-31.log").read_text("utf-8")
    assert text.count("[recorder] boom") == 1 and "ERROR [recorder] boom" in text
    assert "bot at http://127.0.0.1:7420 is online" in text

    # The bot restarted: its sequence numbers start over and are copied again.
    status["process"] = {"startedAt": "2026-11-01T03:00:00Z"}
    sm.Monitor(make_config(tmp_path), fake_fetch(responses), logfile=sm.LogFile(logs, day)).sample_once()
    assert (logs / "scribbot-2026-10-31.log").read_text("utf-8").count("[recorder] boom") == 2


def test_log_file_tail_and_prune(tmp_path):
    from datetime import date

    f = sm.LogFile(tmp_path, Today(date(2026, 10, 31)))
    (tmp_path / "scribbot-2026-10-01.log").write_text("old\n", encoding="utf-8")
    (tmp_path / "scribbot-2026-10-30.log").write_text("yesterday\n", encoding="utf-8")
    f.write(["today"])
    assert f.tail(5) == ["yesterday", "today"]
    f.prune(keep_days=14)
    assert not (tmp_path / "scribbot-2026-10-01.log").exists() and (tmp_path / "scribbot-2026-10-30.log").exists()


def test_no_log_folder_means_no_files(tmp_path):
    f = sm.LogFile(None)
    f.write(["x"])
    f.event("y")
    assert f.tail() == [] and list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------- web server


@pytest.mark.parametrize(
    ("host", "ok"),
    [("127.0.0.1:7422", True), ("localhost:7422", True), ("[::1]:7422", True), ("localhost", True), ("evil.example:7422", False), (None, False)],
)
def test_host_header_check(host, ok):
    assert sm.is_local_host_header(host) is ok


def serve(monitor):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), sm.make_handler(monitor))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture()
def server(tmp_path):
    srv = serve(sm.Monitor(make_config(tmp_path), fake_fetch({"http://127.0.0.1:7420/status": {"warnings": ["hi"], "sessions": []}})))
    yield srv.server_address[1]
    srv.shutdown()
    srv.server_close()


@pytest.fixture()
def offline_server(tmp_path):
    srv = serve(sm.Monitor(make_config(tmp_path), fake_fetch({})))  # nothing answers: the bot is down
    yield srv.server_address[1]
    srv.shutdown()
    srv.server_close()


def get(port: int, path: str, host: str | None = None):
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path, headers={"Host": host or f"127.0.0.1:{port}"})
    res = conn.getresponse()
    body = res.read()
    conn.close()
    return res, body


def test_server_redirects_to_the_bots_dashboard_while_the_bot_is_up(server):
    res, body = get(server, "/status")
    assert res.status == 200 and json.loads(body)["warnings"] == ["hi"]
    for path in ("/", "/dashboard"):
        res, _ = get(server, path)
        assert res.status == 302 and res.getheader("Location") == "http://127.0.0.1:7420/"
    res, _ = get(server, "/monitor/panel.js")  # the old injected panel is gone (05 C2)
    assert res.status == 404


def test_server_shows_the_fallback_page_while_the_bot_is_down(offline_server):
    res, body = get(offline_server, "/")
    assert res.status == 200 and b"ScribBot watchdog" in body and b"/monitor/recent-log" in body
    status = json.loads(get(offline_server, "/status")[1])
    assert status["monitor"]["bot"] == "offline" and status["monitor"]["pipeline"]["shutdown"]["state"] in ("safe", "wait")


def test_recent_log_endpoint_reports_when_disabled(server):
    _, body = get(server, "/monitor/recent-log")
    assert json.loads(body) == {"enabled": False, "folder": "", "lines": []}


def test_server_rejects_foreign_host_names(server):
    res, _ = get(server, "/status", host="attacker.example")
    assert res.status == 403


def test_server_never_returns_the_api_token(server):
    _, body = get(server, "/status")
    assert b"secret-token" not in body
