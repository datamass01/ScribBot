"""Round-trip .env editing: only changed values move, and both dotenv readers agree on what's written."""

from __future__ import annotations

import pytest

from scribconsole.envfile import EnvFile, EnvValueError, format_value
from scribconsole.monitoring import parse_env_file

EXAMPLE = """# ---------- Discord ----------
DISCORD_TOKEN=
DISCORD_CLIENT_ID=

# ---------- Storage ----------
DATA_DIR=./data
CAMPAIGN_DIR=./campaign

# ---------- API ----------
API_PORT=7420
API_TOKEN=change-me
"""


def make(tmp_path, text, crlf=False):
    env = tmp_path / ".env"
    env.write_bytes((text.replace("\n", "\r\n") if crlf else text).encode("utf-8"))
    example = tmp_path / ".env.example"
    example.write_text(EXAMPLE, encoding="utf-8")
    return EnvFile(env, example)


def test_changes_only_the_values_it_is_given(tmp_path):
    text = "# my notes\nDISCORD_TOKEN=abc   # keep this comment\n\nDATA_DIR=./data\nUNKNOWN=1\n"
    f = make(tmp_path, text)
    f.save({"DISCORD_TOKEN": "xyz", "DATA_DIR": "D:\\scrib\\data"})
    assert (tmp_path / ".env").read_text("utf-8") == "# my notes\nDISCORD_TOKEN=xyz   # keep this comment\n\nDATA_DIR=D:\\scrib\\data\nUNKNOWN=1\n"
    assert (tmp_path / ".env.bak").read_text("utf-8") == text
    assert not (tmp_path / ".env.tmp").exists()


def test_keeps_windows_line_endings(tmp_path):
    f = make(tmp_path, "API_PORT=7420\nAPI_TOKEN=a\n", crlf=True)
    f.save({"API_TOKEN": "b"})
    assert (tmp_path / ".env").read_bytes() == b"API_PORT=7420\r\nAPI_TOKEN=b\r\n"


def test_a_new_key_goes_after_its_neighbour_from_the_template(tmp_path):
    f = make(tmp_path, "DISCORD_TOKEN=t\n\nAPI_PORT=7420\n# end\n")
    f.save({"DISCORD_CLIENT_ID": "123", "CAMPAIGN_DIR": "./c", "NOT_IN_TEMPLATE": "x"})
    lines = (tmp_path / ".env").read_text("utf-8").splitlines()
    assert lines[:2] == ["DISCORD_TOKEN=t", "DISCORD_CLIENT_ID=123"]
    assert lines[-1] == "NOT_IN_TEMPLATE=x"
    assert "CAMPAIGN_DIR=./c" in lines


@pytest.mark.parametrize("value", [
    "plain", "", "C:\\Users\\me\\data", "has # hash", " padded ", "it's", 'say "hi"', "a$b", "https://x.example/v1?q=1",
])
def test_written_values_read_back_the_same(tmp_path, value):
    f = make(tmp_path, "API_TOKEN=old\n")
    f.save({"API_TOKEN": value})
    assert parse_env_file(tmp_path / ".env")["API_TOKEN"] == value
    assert f.values()["API_TOKEN"] == value


def test_values_dotenv_could_misread_are_quoted_literally():
    assert format_value("C:\\new\\table") == "C:\\new\\table"  # unquoted: no escapes
    assert format_value("a#b") == "'a#b'"  # node dotenv ends an unquoted value at #
    assert format_value("${HOME}") == "'${HOME}'"  # python-dotenv expands unquoted and double-quoted
    assert format_value("it's") == "it's"  # quotes inside an unquoted value are kept as they are
    assert format_value("it's # here") == "\"it's # here\""


@pytest.mark.parametrize("value", ["two\nlines", "it's \"both\" #1", "it's a\\path #2"])
def test_refuses_values_env_cannot_hold(value):
    with pytest.raises(EnvValueError):
        format_value(value)


def test_refuses_to_overwrite_a_file_changed_meanwhile(tmp_path):
    f = make(tmp_path, "API_TOKEN=a\n")
    version = f.version()
    (tmp_path / ".env").write_text("API_TOKEN=edited by hand\n", "utf-8")
    with pytest.raises(EnvValueError, match="changed"):
        f.save({"API_TOKEN": "b"}, expected_version=version)
    assert f.values()["API_TOKEN"] == "edited by hand"


def test_create_from_the_template_only_once(tmp_path):
    f = EnvFile(tmp_path / ".env", tmp_path / ".env.example")
    (tmp_path / ".env.example").write_text(EXAMPLE, "utf-8")
    f.create_from_example()
    assert f.values()["API_TOKEN"] == "change-me"
    with pytest.raises(EnvValueError):
        f.create_from_example()


# ---------------------------------------------------------------- permissions


def _readable_by_others(path) -> bool:
    """POSIX: any group/other bit. Windows: an ACL entry for anyone but this user and SYSTEM."""
    import os
    import subprocess

    if os.name == "posix":
        return bool(path.stat().st_mode & 0o077)
    sid = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout.split(",")[-1].strip().strip('"')
    acl = subprocess.run(["icacls", str(path), "/save", str(path) + ".acl"], capture_output=True, text=True)
    assert acl.returncode == 0, acl.stdout
    sddl = (path.parent / (path.name + ".acl")).read_text(encoding="utf-16-le").splitlines()[1]
    (path.parent / (path.name + ".acl")).unlink()
    # Allowed SIDs in the DACL, e.g. (A;;FA;;;S-1-5-21-…)(A;;FA;;;SY); and no inherited entries (P = protected).
    import re

    trustees = set(re.findall(r"\(A;[^;]*;[^;]*;;;([^)]+)\)", sddl))
    return "D:P" not in sddl or bool(trustees - {sid, "SY"})


def test_saved_files_are_readable_by_their_owner_only(tmp_path):
    env = EnvFile(tmp_path / ".env")
    (tmp_path / ".env").write_text("DISCORD_TOKEN=old\n", encoding="utf-8")
    env.save({"DISCORD_TOKEN": "new"})
    assert (tmp_path / ".env").read_text(encoding="utf-8") == "DISCORD_TOKEN=new\n"
    assert not _readable_by_others(tmp_path / ".env")
    assert not _readable_by_others(tmp_path / ".env.bak")  # the backup holds the old secrets


def test_a_new_env_from_the_template_is_private_and_identical(tmp_path):
    example = tmp_path / ".env.example"
    example.write_bytes(b"A=1\r\nB=2\r\n")
    EnvFile(tmp_path / ".env", example).create_from_example()
    assert (tmp_path / ".env").read_bytes() == b"A=1\r\nB=2\r\n"
    assert not _readable_by_others(tmp_path / ".env")


def test_saving_still_works_where_permissions_cannot_be_set(tmp_path, monkeypatch, capsys):
    import os

    from scribconsole import envfile

    if os.name == "posix":
        monkeypatch.setattr(envfile.os, "chmod", lambda *a: (_ for _ in ()).throw(OSError("not supported")))
    else:
        monkeypatch.setattr(envfile, "_current_user_sid", lambda run: None)
    (tmp_path / ".env").write_text("A=1\n", encoding="utf-8")
    EnvFile(tmp_path / ".env").save({"A": "2"})
    assert (tmp_path / ".env").read_text(encoding="utf-8") == "A=2\n"
    assert "couldn't limit" in capsys.readouterr().out
