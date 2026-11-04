"""The Console's HTTP server end to end, against a fake bot. Hermetic: temp .env, port 0."""

from __future__ import annotations

import json
import sqlite3
import threading
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from scribconsole.botlink import BotLink, admin_path
from scribconsole.monitoring import Config, LogFile
from scribconsole.server import Console, ConsoleServer, make_handler
from scribconsole.setup_checks import NodeVersion


class FakeBot:
    """Answers /status, /logs and /admin/* like the bot, for one token at a time."""

    def __init__(self, token: str):
        self.token = token
        self.calls: list[tuple[str, str, object]] = []
        bot = self

        class Handler(BaseHTTPRequestHandler):
            def _reply(self, code, data):
                body = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle(self, method):
                if self.headers.get("authorization") != f"Bearer {bot.token}":
                    return self._reply(401, {"error": "invalid or missing API token"})
                if self.headers.get("origin"):
                    return self._reply(403, {"ok": False, "error": "admin routes can't be called from a web page"})
                length = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                bot.calls.append((method, self.path, body))
                if self.path == "/status":
                    return self._reply(200, {"now": "2026-11-01T20:00:00.000Z", "process": {"startedAt": "2026-11-01T19:00:00.000Z"},
                                             "recordings": [], "sessions": [], "warnings": [], "worker": {"reachable": False},
                                             "llm": {}, "foundry": {"sockets": 0}, "disk": {}})
                if self.path.startswith("/logs"):
                    return self._reply(200, [{"seq": 1, "t": "2026-11-01T20:00:00.000Z", "level": "info", "msg": "[api] hello"}])
                if self.path.startswith("/admin/sessions") and method == "GET":
                    return self._reply(200, {"sessions": [{"id": "s1", "number": 1}]})
                if self.path == "/admin/sessions/s1/stop":
                    return self._reply(409, {"ok": False, "error": "That session isn't recording."})
                return self._reply(200, {"ok": True})

            do_GET = lambda self: self._handle("GET")  # noqa: E731
            do_POST = lambda self: self._handle("POST")  # noqa: E731
            do_DELETE = lambda self: self._handle("DELETE")  # noqa: E731

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def write_env(path: Path, bot_url: str, token: str, data_dir: Path):
    port = bot_url.rsplit(":", 1)[1]
    path.write_text(f"API_HOST=127.0.0.1\nAPI_PORT={port}\nAPI_TOKEN={token}\nWORKER_URL=http://127.0.0.1:9\n"
                    f"DATA_DIR={data_dir}\nCAMPAIGN_DIR={data_dir.parent / 'campaign'}\nDISCORD_TOKEN=discord-secret\n", "utf-8")


@pytest.fixture()
def setup(tmp_path, monkeypatch):
    for key in ("API_TOKEN", "API_PORT", "API_HOST", "DATA_DIR", "CAMPAIGN_DIR", "WORKER_URL", "LLM_MODEL", "DISCORD_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    bot = FakeBot("old-token")
    env = tmp_path / ".env"
    write_env(env, bot.url, "old-token", tmp_path / "data")
    cfg = Config.load(env, environ={})
    console = Console(cfg, LogFile(tmp_path / "logs"), env_path=env, node=NodeVersion(lambda: "v24.1.0"))
    console.settings.environ = {}
    srv = ConsoleServer(("127.0.0.1", 0), make_handler(console))
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    yield {"port": srv.server_address[1], "bot": bot, "console": console, "env": env, "tmp": tmp_path}
    srv.shutdown()
    srv.server_close()
    bot.close()


def request(port, method, path, body=None, headers=None, console_header=True):
    conn = HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"Host": f"127.0.0.1:{port}"}
    if console_header:
        h["X-Scrib-Console"] = "1"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    conn.request(method, path, body=data, headers=h)
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    try:
        return res.status, json.loads(raw)
    except ValueError:
        return res.status, raw


def test_serves_the_page_and_only_its_own_files(setup):
    port = setup["port"]
    status, body = request(port, "GET", "/")
    assert status == 200 and b"ScribBot Console" in body
    assert request(port, "GET", "/static/app.js")[0] == 200
    assert request(port, "GET", "/static/../server.py")[0] == 404
    assert request(port, "GET", "/static/%2e%2e%2fserver.py")[0] == 404


def test_refuses_foreign_host_names(setup):
    assert request(setup["port"], "GET", "/status", headers={"Host": "attacker.example"})[0] == 403


@pytest.mark.parametrize(("headers", "console_header"), [
    ({}, False),  # a plain cross-site form post can't set the header
    ({"Origin": "https://evil.example"}, True),
    ({"Origin": "http://127.0.0.1:1"}, True),  # another local port
    ({"Sec-Fetch-Site": "cross-site"}, True),
])
def test_changes_need_the_console_header_and_a_local_origin(setup, headers, console_header):
    status, body = request(setup["port"], "POST", "/api/admin/sessions/s1/stop", {}, headers=headers, console_header=console_header)
    assert status == 403
    assert setup["bot"].calls == []


def test_a_form_post_is_refused(setup):
    conn = HTTPConnection("127.0.0.1", setup["port"], timeout=5)
    conn.request("POST", "/api/config", body=b"changes=x", headers={"Host": f"127.0.0.1:{setup['port']}", "X-Scrib-Console": "1",
                                                                   "Content-Type": "application/x-www-form-urlencoded"})
    assert conn.getresponse().status == 403


def test_relays_admin_calls_with_the_token_kept_server_side(setup):
    port = setup["port"]
    status, body = request(port, "GET", "/api/admin/sessions?deleted=only")
    assert status == 200 and body["sessions"][0]["id"] == "s1"
    status, body = request(port, "POST", "/api/admin/sessions/s1/stop", {})
    assert (status, body) == (409, {"ok": False, "error": "That session isn't recording."})
    assert ("GET", "/admin/sessions?deleted=only", None) in setup["bot"].calls
    for path in ("/status", "/api/config", "/api/setup", "/api/logs?after=0", "/api/admin/sessions"):
        raw = json.dumps(request(port, "GET", path)[1])
        assert "old-token" not in raw and "discord-secret" not in raw, path
    assert request(port, "GET", "/api/admin/..%2Fstatus")[0] in (400, 404)


def test_admin_paths_are_plain():
    assert admin_path("sessions/s1/stop") == "/admin/sessions/s1/stop"
    assert admin_path("sessions/../status") is None
    assert admin_path("sessions/a b") is None
    assert admin_path("") is None


def test_sessions_are_read_only_from_the_database_while_the_bot_is_down(setup):
    setup["bot"].close()
    data = setup["tmp"] / "data"
    data.mkdir()
    db = sqlite3.connect(data / "scribbot.db")
    db.execute("CREATE TABLE sessions (id TEXT, guild_id TEXT, channel_id TEXT, text_channel_id TEXT, number INT, status TEXT, error TEXT,"
               " started_at TEXT, ended_at TEXT, summarized_at TEXT, audio_purged INT)")
    db.execute("INSERT INTO sessions VALUES ('s9','g','c','t',9,'complete',NULL,'2026-11-01T18:00:00Z',NULL,NULL,0)")
    db.commit()
    db.close()
    status, body = request(setup["port"], "GET", "/api/admin/sessions")
    assert status == 200 and body["readOnly"] is True and body["sessions"][0]["number"] == 9
    status, body = request(setup["port"], "POST", "/api/admin/sessions/s9/process", {})
    assert status == 503 and body["offline"] is True


def test_saving_settings_writes_env_and_reports_restarts(setup):
    port = setup["port"]
    view = request(port, "GET", "/api/config")[1]
    assert view["values"]["DISCORD_TOKEN"]["set"] is True and "value" not in view["values"]["DISCORD_TOKEN"]
    status, body = request(port, "POST", "/api/config", {"version": view["version"], "changes": {"WHISPER_BEAM_SIZE": "3", "LLM_MODEL": "m"}})
    assert status == 200 and sorted(body["changed"]) == ["LLM_MODEL", "WHISPER_BEAM_SIZE"]
    # LLM_MODEL is live: the bot re-reads it for the next summary and the Console reloads at once.
    assert set(body["pendingRestart"]) == {"worker"}
    text = setup["env"].read_text("utf-8")
    assert "WHISPER_BEAM_SIZE=3" in text and "LLM_MODEL=m" in text and "DISCORD_TOKEN=discord-secret" in text
    status, body = request(port, "POST", "/api/config", {"version": view["version"], "changes": {"LLM_MODEL": "n"}})
    assert status == 409  # based on a stale version
    status, body = request(port, "POST", "/api/config", {"changes": {"API_PORT": "nope"}})
    assert status == 400 and "API_PORT" in body["problems"]
    log = "".join(p.read_text("utf-8") for p in (setup["tmp"] / "logs").glob("*.log"))
    assert "settings saved: " in log and "=m" not in log  # names, never values


def test_a_new_api_token_still_reaches_a_bot_that_has_not_restarted(setup):
    port = setup["port"]
    version = request(port, "GET", "/api/config")[1]["version"]
    assert request(port, "POST", "/api/config", {"version": version, "changes": {"API_TOKEN": "new-token"}})[0] == 200
    assert request(port, "GET", "/api/admin/sessions")[1]["sessions"]  # old token, as a fallback
    setup["bot"].token = "new-token"  # the bot restarts with the new one
    assert request(port, "GET", "/api/admin/sessions")[1]["sessions"]


def test_the_worker_is_not_restarted_while_recording(setup, monkeypatch):
    console = setup["console"]
    monkeypatch.setattr(console.monitor, "status", lambda: {"monitor": {"pipeline": {"shutdown": {"state": "no", "reasons": []}}}})
    status, body = request(setup["port"], "POST", "/api/worker/restart", {})
    assert status == 409 and "recording" in body["error"]


def test_the_worker_restart_asks_first_while_busy(setup, monkeypatch):
    console = setup["console"]
    monkeypatch.setattr(console.monitor, "status", lambda: {"monitor": {"pipeline": {"shutdown": {"state": "wait", "reasons": ["3 clips"]}}}})
    status, body = request(setup["port"], "POST", "/api/worker/restart", {})
    assert status == 409 and body["needsConfirm"] is True


def test_setup_checklist_runs_without_anything_else(setup):
    checks = {c["id"]: c for c in request(setup["port"], "GET", "/api/setup")[1]["checks"]}
    assert checks["env"]["state"] == "ok"
    assert checks["node"]["state"] == "ok"
    assert checks["discord-config"]["state"] == "err"  # no DISCORD_CLIENT_ID
    assert checks["worker"]["state"] == "warn"


def test_campaign_files_are_edited_in_place(setup):
    port = setup["port"]
    assert request(port, "PUT", "/api/campaign/glossary", {"text": "- Thorin\n"})[0] == 200
    assert request(port, "GET", "/api/campaign/glossary")[1]["text"] == "- Thorin\n"
    assert request(port, "PUT", "/api/campaign/secrets", {"text": "x"})[0] == 400
    assert (setup["tmp"] / "campaign" / "glossary.md").read_text("utf-8") == "- Thorin\n"  # never the repo's campaign/


def test_each_campaign_has_its_own_notes_starting_from_the_shared_ones(setup):
    port = setup["port"]
    camp = setup["tmp"] / "campaign"
    request(port, "PUT", "/api/campaign/context", {"text": "Shared lore"})
    status, note = request(port, "GET", "/api/campaign/context?campaign=strahd")
    assert status == 200 and note["inherited"] is True and note["exists"] is False and note["text"] == "Shared lore"
    assert request(port, "PUT", "/api/campaign/context?campaign=strahd", {"text": "Barovia"})[0] == 200
    assert (camp / "strahd" / "context.md").read_text("utf-8") == "Barovia"
    assert (camp / "context.md").read_text("utf-8") == "Shared lore"  # the shared one is untouched
    note = request(port, "GET", "/api/campaign/context?campaign=strahd")[1]
    assert note["inherited"] is False and note["text"] == "Barovia"
    for bad in ("..", "a/b", ".hidden", "x%5Cy"):
        assert request(port, "GET", f"/api/campaign/context?campaign={bad}")[0] == 404
        assert request(port, "PUT", f"/api/campaign/context?campaign={bad}", {"text": "x"})[0] == 400


def test_campaigns_are_read_only_from_the_database_while_the_bot_is_down(setup):
    setup["bot"].close()
    data = setup["tmp"] / "data"
    data.mkdir()
    db = sqlite3.connect(data / "scribbot.db")
    db.execute("CREATE TABLE sessions (id TEXT, campaign_id INT, merged_into_id TEXT, deleted_at TEXT)")
    db.execute("CREATE TABLE campaigns (id INTEGER PRIMARY KEY, world_id TEXT, folder TEXT, title TEXT, alias TEXT, last_seen_at TEXT,"
               " created_at TEXT, foundry_url TEXT, foundry_user TEXT, foundry_password TEXT, selected_at TEXT)")
    db.execute("INSERT INTO campaigns VALUES (1,'strahd','strahd','Barovia','Strahd',NULL,'x','https://vtt','Scribe','hunter2','2026-11-01')")
    db.execute("INSERT INTO sessions VALUES ('s1',1,NULL,NULL)")
    db.commit()
    db.close()
    status, body = request(setup["port"], "GET", "/api/admin/campaigns")
    assert status == 200 and body["readOnly"] is True and body["chosenId"] == 1
    c = body["campaigns"][0]
    assert c["foundry"] == {"url": "https://vtt", "user": "Scribe", "passwordSet": True}
    assert c["sessions"] == 1 and c["isDefault"] is True and c["name"] == "Strahd"
    assert "hunter2" not in json.dumps(body)
    assert request(setup["port"], "POST", "/api/admin/campaigns/playing", {"campaignId": 1})[0] == 503


def test_bot_link_promotes_the_pair_that_works():
    seen = []

    def fake(method, url, token, body, timeout):
        seen.append(token)
        from scribconsole.botlink import Reply
        return Reply(200 if token == "b" else 401, {"ok": token == "b"})

    link = BotLink("http://127.0.0.1:1", "b", request=fake)
    link.remember("http://127.0.0.1:1", "a")
    assert link.call("GET", "/admin/x").status == 200
    assert seen == ["a", "b"]
    seen.clear()
    link.call("GET", "/admin/x")
    assert seen == ["b"]


def test_setup_check_flags_an_empty_model(tmp_path):
    from scribconsole.setup_checks import run_checks

    def llm_check(llm):
        checks = run_checks(tmp_path, {}, {"llm": llm}, NodeVersion(lambda: "v22.12.0"), env_exists=True)
        return next(c for c in checks if c["id"] == "llm")

    # openai-compatible with no LLM_MODEL: the bot reports model null, which /scrib summarize rejects.
    check = llm_check({"provider": "openai-compatible", "model": None, "credentials": "base url http://localhost:11434/v1"})
    assert check["state"] == "err" and "Model is empty" in check["detail"]
    assert llm_check({"provider": "anthropic", "model": "claude-opus-5-5", "credentials": "api key"})["state"] == "ok"
