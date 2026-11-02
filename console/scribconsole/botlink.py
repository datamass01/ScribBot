"""Calls from the Console to the bot's /admin API and the worker, with API_TOKEN kept server-side.

After the Configuration tab changes API_TOKEN, API_HOST or API_PORT, the running bot keeps the old
ones until it restarts. So the link remembers every (URL, token) pair it has been given and uses the
first that works, newest first; the Console never locks itself out of a bot that hasn't restarted.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

TIMEOUT_S = 10
# Starting a recording joins voice; testing the LLM waits for a model. Both can take a while.
SLOW_TIMEOUT_S = 75


@dataclass
class Reply:
    status: int
    body: Any


class BotUnreachable(URLError):
    """No remembered address answered (a URLError, so monitoring treats it as "bot offline")."""


def _request(method: str, url: str, token: str | None, body: Any = None, timeout: float = TIMEOUT_S) -> Reply:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if data is not None:
        headers["content-type"] = "application/json"
    req = Request(url, data=data, method=method, headers=headers)
    try:
        with urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return Reply(res.status, json.loads(raw) if raw else None)
    except HTTPError as err:
        raw = err.read()
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = {"ok": False, "error": raw.decode("utf-8", "replace")[:300]}
        return Reply(err.code, parsed)


class BotLink:
    def __init__(self, url: str, token: str, request=_request):
        self._lock = threading.Lock()
        self._candidates: list[tuple[str, str]] = [(url.rstrip("/"), token)]
        self._request = request

    def remember(self, url: str, token: str) -> None:
        """New settings from .env: tried first from now on, the old ones kept as a fallback."""
        pair = (url.rstrip("/"), token)
        with self._lock:
            self._candidates = [pair] + [c for c in self._candidates if c != pair][:3]

    @property
    def url(self) -> str:
        return self._candidates[0][0]

    @property
    def token(self) -> str:
        return self._candidates[0][1]

    def fetch(self, url: str, token: str | None = None, timeout: float = TIMEOUT_S) -> Any:
        """Drop-in for monitoring.fetch_json: a GET to the bot tries each remembered pair."""
        with self._lock:
            candidates = list(self._candidates)
        bot_prefix = next((u for u, _ in candidates if url.startswith(u + "/")), None)
        if bot_prefix is None:  # not the bot (the worker): as asked
            reply = self._request("GET", url, token, None, timeout)
            if reply.status >= 400:
                raise HTTPError(url, reply.status, str(reply.body), None, None)  # type: ignore[arg-type]
            return reply.body
        path = url[len(bot_prefix):]
        reply = self.call("GET", path, timeout=timeout)
        if reply.status >= 400:
            raise HTTPError(url, reply.status, str(reply.body), None, None)  # type: ignore[arg-type]
        return reply.body

    def call(self, method: str, path: str, body: Any = None, timeout: float = TIMEOUT_S) -> Reply:
        """`path` like /admin/sessions. Raises BotUnreachable when no remembered address answers."""
        with self._lock:
            candidates = list(self._candidates)
        last: Exception | None = None
        rejected: Reply | None = None
        for i, (url, token) in enumerate(candidates):
            try:
                reply = self._request(method, url + path, token, body, timeout)
            except (URLError, OSError, ValueError) as err:
                last = err
                continue
            if reply.status == 401 and i + 1 < len(candidates):
                rejected = reply
                continue  # the bot may still have an older token
            if i:
                with self._lock:  # promote the pair that worked
                    self._candidates = [candidates[i]] + [c for c in self._candidates if c != candidates[i]]
            return reply
        if rejected is not None:
            return rejected
        raise BotUnreachable(str(getattr(last, "reason", last) or "no answer"))


def admin_path(rest: str, query: str = "") -> str | None:
    """/admin/<rest> for a path the browser asked for, or None if it isn't a plain admin path."""
    parts = rest.strip("/").split("/")
    if not rest.strip("/") or any(p in ("", ".", "..") for p in parts):
        return None
    if not all(all(c.isalnum() or c in "-_.:" for c in p) for p in parts):
        return None
    path = "/admin/" + "/".join(quote(p, safe="-_.:") for p in parts)
    return path + (f"?{query}" if query else "")


def worker_call(worker_url: str, method: str, path: str, body: Any = None, request=_request) -> Reply:
    try:
        return request(method, worker_url.rstrip("/") + path, None, body, TIMEOUT_S)
    except (URLError, OSError, ValueError) as err:
        raise BotUnreachable(str(getattr(err, "reason", err))) from err
