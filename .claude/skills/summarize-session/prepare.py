#!/usr/bin/env python3
"""Build an LLM-ready evidence pack for one or more ScribBot sessions.

Reads only what the app already wrote (transcript.json or transcript.partial.jsonl,
timeline.json, chatlog.json, summary.json, campaign/*.md, data/scribbot.db) and
writes everything into <out>/ (default data/sessions/<first-id>/story/):

  pack.md         the whole session: participants, campaign notes, Foundry facts,
                  noise report, and the cleaned chronological stream with line IDs
  chunks/NN.md    the same stream cut into ~N-minute parts, each self-contained,
                  for models with small context windows
  noise.md        every line dropped as a likely transcription hallucination, with why
  lines.json      every line (id, time, speaker, text, dropped, tags) for verify.py
  summary.story.md  the story to write, started from the skill's template.md with this
                  session's byline, Foundry roster and Deeds rows filled in. Created only
                  when it doesn't exist yet, so a story in progress is never overwritten
  prompt-full.md  PROMPT.md + pack.md + template.md in one file, to paste into any chat model

Standard library only (Python 3.10+). Never writes outside <out>/. Refuses a
session that is still recording (the bot is writing its files).

Usage:
  python prepare.py <session> [<session> ...] [--out DIR] [--chunk-minutes 30]
  <session> is a folder id (2026-11-01-6ae0bcc6), a session number (12), or "latest".
  Several sessions are stitched into one story in start-time order (an interrupted
  game that was recorded as two sessions).
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent
REPO = SKILL_DIR.parents[2]
DATA = REPO / "data"
SESSIONS = DATA / "sessions"
sys.path.insert(0, str(SKILL_DIR))
import layout  # noqa: E402  (section order, limits and the story template, shared with verify.py)


def foundry_actors(session_ids: list[str]) -> tuple[list[dict], str]:
    """Character and NPC details the Foundry module synced: the latest session's own copy
    (data/sessions/<id>/actors.json, saved at session start and stop), else the world-wide
    data/foundry-actors.json from the last sync."""
    for sid in reversed(session_ids):
        f = SESSIONS / sid / "actors.json"
        try:
            return json.loads(f.read_text(encoding="utf-8")), f"session {sid}"
        except (OSError, ValueError):
            continue
    try:
        return json.loads((DATA / "foundry-actors.json").read_text(encoding="utf-8")), "last roster sync (no copy saved with this session)"
    except (OSError, ValueError):
        return [], "none"


def foundry_sheets(actors: list[dict]) -> dict[str, dict]:
    """Class(es) and level per character name."""
    return {a["name"]: {"classes": a.get("classes") or [], "level": a.get("level")} for a in actors if a.get("name")}


DETAIL_FIELDS = ["race", "gender", "age", "height", "weight"]


def has_details(a: dict) -> bool:
    return bool(a.get("classes")) or any(a.get(k) not in (None, "") for k in DETAIL_FIELDS + ["level", "hpMax"])


def mentioned(name: str, text: str) -> bool:
    """Is this actor named in the session? The full name (any case, plural too: "goblins"), or
    one of its capitalised words that is not a title ("Vell" for "Mayor Vell"), as a whole word."""
    if re.search(r"\b" + re.escape(name) + r"(e?s)?\b", text, re.I):
        return True
    words = [w for w in re.findall(r"[A-Za-z'-]+", name) if len(w) >= 4 and w[0].isupper() and w.lower() not in TITLES]
    return any(re.search(r"\b" + re.escape(w) + r"\b", text) for w in words)


# Words in NPC names that say what someone is, not who: never enough on their own.
TITLES = {
    "lord", "lady", "mayor", "captain", "sister", "brother", "father", "mother", "master", "mistress", "king",
    "queen", "prince", "princess", "duke", "duchess", "baron", "baroness", "count", "countess", "elder", "young",
    "high", "priest", "priestess", "general", "commander", "sergeant", "guard", "guardsman", "chief", "chieftain",
    "great", "dread", "grand", "warrior", "soldier", "bandit", "cultist", "acolyte", "captain", "dame", "sire",
    "uncle", "aunt", "granny", "goodman", "goodwife", "merchant", "innkeeper", "keeper", "leader", "boss",
}


def details_table(rows: list[dict]) -> list[str]:
    cell = lambda v: str(v).replace("|", "/") if v not in (None, "") else "-"
    out = ["| Name | Race | Sex/gender | Age | Height | Weight | Class(es) and level | Max HP |", "|---|---|---|---|---|---|---|---|"]
    for a in rows:
        cls = layout.class_text(a.get("classes") or [])
        if cls == layout.UNKNOWN:
            cls = f"level {a['level']}" if a.get("level") is not None else "-"
        elif a.get("level") is not None and len(a.get("classes") or []) > 1:
            cls += f" (level {a['level']})"
        out.append(f"| {cell(a['name'])} | " + " | ".join(cell(a.get(k)) for k in DETAIL_FIELDS) + f" | {cls} | {cell(a.get('hpMax'))} |")
    return out


# ---------------------------------------------------------------- hallucination rules

# Whisper was trained on subtitled video. On silence, breath, laughter or mic noise it
# emits the boilerplate that most often sat on such audio. Any line containing these
# is not speech, whatever its length.
BOILERPLATE = re.compile(
    r"(thanks?|you) (you )?for watching|please (like|subscribe)|like and subscribe|subscribe to (my|the|our) channel"
    r"|hit the bell|bell icon|see you (guys )?(in|on) the next (video|one|episode)|next video"
    r"|closed caption(s|ing)?\b|caption(s|ing)? (provided )?by|subtitles? (by|provided)|transcribed by|transcription by"
    r"|amara ?\.? ?org|gettranscribed|imperial news network|\bcsi\b.*caption|www\.|\.com\b|copyright ©|all rights reserved"
    r"|see you (all |guys )?next time|\b(this|the|my|our|next) (video|episode)\b|first part of the|made possible by"
    r"|(written|directed|edited|produced),? (and |directed |edited )*by|for more videos|work of fiction|resemblance to (actual|real) persons",
    re.I,
)
# Whole-line phrases Whisper produces for short non-speech. Real only when the clip is
# long enough, confidently decoded, or answers something just said.
SILENCE_PHRASES = {
    "thank you", "thank you very much", "thank you so much", "thanks", "thank you thank you",
    "you", "bye", "bye bye", "goodbye", "the end", "so", "i'm sorry", "sorry",
}
# Pure fillers: real sounds, but no story value. Dropped quietly, counted separately.
FILLERS = {"um", "uh", "hmm", "mm", "mmm", "mm hmm", "uh huh", "oh", "ah", "huh", "eh", "uh oh", "ooh", "whoa", "wow"}
REPLIES = {"no", "yes", "yeah", "yep", "nope", "okay", "ok", "sure", "right", "wait", "hey", "what", "nice", "cool", "fine", "good"}
MIC_CHECK = re.compile(r"^(one|1)( two| 2)?( three| 3)?( four)?$|^(test|testing)( test(ing)?)*$|^check( check)*$")
LAUGH = re.compile(r"^(?:(?:ha|haha|he|heh|hah|hee|lol|ah)[\s,.!-]*)+$", re.I)
THANKS_TRIGGER = re.compile(r"\b(here|take|have|give|gives?|hand|pass|heal|healed|helps?|saved?|cast|buff|bless|for you|you're welcome)\b", re.I)
NON_LATIN = re.compile(r"[Ѐ-ӿ֐-ۿऀ-෿぀-ヿ㐀-鿿가-힯]")

# ---------------------------------------------------------------- hint rules (the LLM decides)

REAL_WORLD = re.compile(
    r"\b(daughter|son|wife|husband|kids?|mom|dad|baby|dog|cat|car|driv(e|ing)|work|job|boss|pizza|dinner|lunch|snack|beer|"
    r"bathroom|brb|be right back|afk|mic|microphone|mute|unmute|headset|discord|foundry|internet|wi-?fi|lag|laggy|"
    r"can you hear|hear me|screen|refresh|browser|reload|update|computer|laptop|phone|tonight|tomorrow|next week|"
    r"schedule|bed|sleep|tired|nyquil|sick|youtube|movie|netflix|halloween|candy)\b",
    re.I,
)
MECHANICS = re.compile(
    r"\b(roll(ed|ing)?|d(4|6|8|10|12|20|100)|nat(ural)? ?(1|20|one|twenty)|initiative|modifier|bonus action|reaction|"
    r"advantage|disadvantage|saving throw|save|dc|ac|armou?r class|spell slots?|concentration|cantrip|level \d|"
    r"hit points|hp|temp hp|my turn|your turn|whose turn|round|attack roll|to hit|proficiency)\b",
    re.I,
)
DAMAGE = re.compile(
    r"\b(\d+\s*(points? of )?(damage|dmg|hp|hit points|healing|points)|damage|crit(ical)?( hit)?|nat(ural)? ?(20|twenty|1|one)|"
    r"heal(s|ed|ing)?|unconscious|down(ed)?|drops? to (0|zero)|dies|died|dead|kill(s|ed)?|slain|death saves?|"
    r"half (my|your|his|her) (health|hp))\b",
    re.I,
)
# Table talk that may need follow-up: promises, homework, scheduling, fixes to make.
TODO = re.compile(
    r"\b(next (time|session|week|game)|before next|remind (me|us|him|her)|don't forget|do not forget|remember to|"
    r"need to (fix|update|check|look|set|add|change|level|buy|read)|i'?ll (fix|update|check|look|set|add|send|change|figure)|"
    r"let me (check|look|take a look|find|fix)|look (it|that) up|have to (fix|update|check)|permissions?|homework|"
    r"level(ing)? up|level up|schedule|reschedule|we should|you should|make sure|"
    r"(fix|update|recheck|re-check) (it|that|your|my|the)|required to|continue (their|the|our) (roleplay|role-?playing))\b",
    re.I,
)
# Rules questions and rulings made at the table.
RULING = re.compile(
    r"\b(does it\?|is that right|i don't believe|says (that|it)|under (the )?[a-z]+ (it says|in the)|rules? (as written|say)|"
    r"house rule|ruling|i looked (that|it) up|let me take a look|supernatural|extraordinary|suppress(es|ed)?|"
    r"how does .* work|can i (continue|still|do)|would require|it would require)\b",
    re.I,
)
ITEMS = re.compile(
    r"\b(ring|amulet|necklace|staff|wand|rod|orb|sword|blade|dagger|axe|bow|crossbow|shield|armou?r|helm|cloak|boots|gloves|"
    r"gauntlets?|potions?|scrolls?|tome|book|map|key|chest|pouch|bag of holding|bag|gold|gp|platinum|gems?|coins?|"
    r"artifact|relic|idol|crown|\+\d)\b",
    re.I,
)


def norm(text: str) -> str:
    t = text.lower().replace("-", " ").replace("’", "'")
    t = re.sub(r"[^\w\s']", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def repeats(words: list[str], times: int) -> bool:
    """True if some 1-4 word phrase occurs `times` or more in a row."""
    for n in range(1, 5):
        for i in range(len(words) - n * times + 1):
            unit = words[i:i + n]
            if all(words[i + k * n:i + (k + 1) * n] == unit for k in range(1, times)):
                return True
    return False


def collapse_loops(text: str) -> tuple[str, bool]:
    """Collapse a phrase repeated 4+ times in a row (Whisper's decode loop) to two copies."""
    words = text.split()
    changed = False
    for n in range(1, 6):
        i, out = 0, []
        while i < len(words):
            unit = [norm(w) for w in words[i:i + n]]
            reps = 1
            while len(unit) == n and [norm(w) for w in words[i + reps * n:i + (reps + 1) * n]] == unit:
                reps += 1
            if reps >= 4 and any(unit):
                out += words[i:i + 2 * n] + ["…"]
                i += reps * n
                changed = True
            else:
                out.append(words[i])
                i += 1
        words = out
    return " ".join(words), changed


# ---------------------------------------------------------------- data model

@dataclass
class Line:
    t: float               # seconds from the start of the first stitched session
    end: float
    speaker: str           # label used in the stream: character, "GM", or display name
    discord_id: str
    is_gm: bool
    text: str
    prob: float | None = None
    session: int | None = None
    id: str = ""
    tags: list[str] = field(default_factory=list)
    drop: str | None = None   # reason, if dropped as noise
    filler: bool = False      # dropped as filler/laughter (not a hallucination)


def fmt(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def iso_ms(s: str | None) -> float | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000


def db_connect():
    path = DATA / "scribbot.db"
    if not path.exists():
        return None
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)


def resolve_session(arg: str, db) -> tuple[str, dict]:
    """Return (folder id, db row as dict or {})."""
    rows = []
    if db is not None:
        cur = db.execute("select id, number, status, started_at, ended_at from sessions order by started_at desc")
        rows = [dict(zip(("id", "number", "status", "started_at", "ended_at"), r)) for r in cur]
    if arg == "latest":
        for r in rows:
            if r["status"] != "recording" and (SESSIONS / r["id"] / "transcript.json").exists():
                return r["id"], r
        sys.exit("No finished session with a transcript.json found.")
    if arg.isdigit():
        for r in rows:
            if r["number"] == int(arg):
                return r["id"], r
        sys.exit(f"No session number {arg} in data/scribbot.db.")
    if not (SESSIONS / arg).is_dir():
        sys.exit(f"No session folder data/sessions/{arg}.")
    return arg, next((r for r in rows if r["id"] == arg), {})


def load_session(sid: str, row: dict, mapped: dict[str, tuple[str | None, bool]]):
    folder = SESSIONS / sid
    if row.get("status") == "recording":
        sys.exit(f"Session {row.get('number')} ({sid}) is still recording. Summarize it after /scrib stop.")
    timeline = json.loads((folder / "timeline.json").read_text(encoding="utf-8"))
    parts = {p["discordId"]: p for p in timeline.get("participants", [])}
    # Sessions recorded before a /scrib map have no character in their timeline.
    # Fill the gap from today's mappings, the same table the bot resolves from.
    for did, p in parts.items():
        if not p.get("character") and not p.get("isGm") and did in mapped:
            p["character"], p["isGm"] = mapped[did]

    def label(did: str, fallback: str, character: str | None, is_gm: bool):
        p = parts.get(did, {})
        if is_gm or p.get("isGm"):
            return "GM"
        return character or p.get("character") or fallback

    lines: list[Line] = []
    gaps: list[float] = []
    tpath = folder / "transcript.json"
    if tpath.exists():
        tr = json.loads(tpath.read_text(encoding="utf-8"))
        for l in tr["lines"]:
            if l["discordId"] == "scribbot":   # /scrib merge's marker where the recording resumed
                gaps.append(l["t"])
                continue
            is_gm = l["isGm"] or bool(parts.get(l["discordId"], {}).get("isGm"))
            lines.append(Line(l["t"], l["end"], label(l["discordId"], l["speaker"], l.get("character"), l["isGm"]),
                              l["discordId"], is_gm, l["text"]))
        source = f"transcript.json ({tr.get('model')})"
    elif (folder / "transcript.partial.jsonl").exists():
        # Not finalized yet (crash, or /scrib process still running). The partial file
        # keeps Whisper's word probability, which the final transcript drops.
        seg_start = {s["file"]: s["startMs"] / 1000 for s in timeline.get("segments", [])}
        for raw in (folder / "transcript.partial.jsonl").read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            rec = json.loads(raw)
            f = rec["file"]
            did = f.split("/")[1]
            p = parts.get(did, {})
            base = seg_start.get(f)
            if base is None:
                continue
            for s in rec.get("segments", []):
                lines.append(Line(base + s["start"], base + s["end"],
                                  label(did, p.get("displayName", did), p.get("character"), p.get("isGm", False)),
                                  did, p.get("isGm", False), s["text"], s.get("probability")))
        lines.sort(key=lambda x: x.t)
        source = "transcript.partial.jsonl (not finalized; has word probabilities)"
    else:
        sys.exit(f"{sid} has no transcript yet. Run /scrib process first.")

    chat = None
    if (folder / "chatlog.json").exists():
        chat = json.loads((folder / "chatlog.json").read_text(encoding="utf-8"))
    summary = None
    if (folder / "summary.json").exists():
        summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    return {
        "id": sid, "row": row, "timeline": timeline, "participants": list(parts.values()),
        "lines": lines, "gaps": gaps, "chat": chat, "summary": summary, "source": source,
        "start_ms": iso_ms(timeline.get("startedAt")) or 0, "end_ms": iso_ms(timeline.get("endedAt")),
    }


# ---------------------------------------------------------------- classification

def classify(lines: list[Line], glossary_names: set[str], characters: set[str]) -> None:
    known_names = glossary_names | {c.lower() for c in characters} | {w.lower() for c in characters for w in c.split()}
    phrase_count = Counter(norm(l.text) for l in lines)
    for i, l in enumerate(lines):
        dur = max(0.05, l.end - l.t)
        n = norm(l.text)
        words = n.split()
        if not n:
            l.drop = "empty"
            continue
        m = BOILERPLATE.search(l.text)
        if m:
            # Whisper sometimes tacks the outro onto real speech ("...a drop off below
            # you, thanks for watching"). Keep a substantial real prefix, drop the rest.
            head = re.sub(r"[\s,.!-]*(and|as always|thank you|thanks)?[\s,.!-]*$", "", l.text[:m.start()], flags=re.I).strip()
            if len(norm(head).split()) >= 6 and not BOILERPLATE.search(head):
                l.text = head + " …"
                l.tags.append("boilerplate-trimmed")
                n = norm(head)
                words = n.split()
            else:
                l.drop = "video-subtitle boilerplate (Whisper training-data artefact)"
                continue
        if NON_LATIN.search(l.text):
            l.drop = "output in another script (wrong-language hallucination)"
            continue
        if LAUGH.match(l.text.strip()):
            l.drop, l.filler = "laughter", True
            continue
        if n in FILLERS:
            l.drop, l.filler = "filler sound", True
            continue
        raw = l.text.strip()
        if len(words) <= 3 and raw.endswith(",") and all(w[:1].isupper() for w in raw.rstrip(",").replace(",", " ").split()):
            l.drop = f"capitalised fragment ending in a comma ('{raw}'): a name pulled out of noise"
            continue
        if n in SILENCE_PHRASES:
            prev = next((p for p in reversed(lines[max(0, i - 4):i]) if p.discord_id != l.discord_id and l.t - p.end < 10), None)
            elicited = prev is not None and THANKS_TRIGGER.search(prev.text)
            confident = l.prob is not None and l.prob >= 0.8
            if dur >= 2.0 or confident or elicited:
                l.tags.append("thanks-real?" if n.startswith("thank") else "short")
            else:
                why = f"'{l.text.strip()}' on a {dur:.1f}s clip"
                if l.prob is not None:
                    why += f", word probability {l.prob:.2f}"
                l.drop = f"silence phrase ({why}, nothing just said invites it)"
                continue
        items = [x.strip() for x in l.text.split(",") if x.strip()]
        too_fast = len(words) >= 6 and len(words) / dur > 8
        if len(words) >= 6 and len(set(words)) <= 3 and repeats(words, 3):
            l.drop = "the same phrase over and over, nothing else (decoder loop)"
            continue
        if too_fast and (len(items) >= 4 or repeats(words, 3)):
            l.drop = f"{len(words)} words in {dur:.1f}s, repeating or listing: decoder invented it"
            continue
        if too_fast:
            l.tags.append(f"timing? {len(words)} words in {dur:.1f}s")
        if len(items) >= 4:
            named = sum(1 for x in items if x.lower() in glossary_names or (len(x.split()) <= 3 and x[:1].isupper()))
            if named / len(items) >= 0.6 and len(words) / dur > 4:
                l.drop = "list of names recited (hotword prompt echoed back)"
                continue
        if l.prob is not None and l.prob < 0.35 and dur < 1.5:
            l.drop = f"low-confidence short clip (probability {l.prob:.2f})"
            continue
        text, looped = collapse_loops(l.text)
        if looped:
            l.text = text
            l.tags.append("loop-collapsed")
        if phrase_count[n] >= 3 and len(words) >= 3 and dur < 2.0:
            l.tags.append(f"repeated x{phrase_count[n]}?")
        if l.prob is not None and l.prob < 0.55:
            l.tags.append(f"low-confidence {l.prob:.2f}")
        if (len(words) <= 3 and dur < 1.2 and all(w[:1].isupper() for w in raw.split())
                and not re.search(r"[.?!]$", raw) and n not in known_names and n not in REPLIES):
            l.tags.append("noise?")
        if MIC_CHECK.match(n):
            l.tags.append("ooc?:mic check")
        # Story hints. These are cheap regexes: the model makes the call.
        if REAL_WORLD.search(l.text):
            l.tags.append("ooc?:real world")
        if MECHANICS.search(l.text):
            l.tags.append("mech")
        if DAMAGE.search(l.text):
            l.tags.append("dmg")
        if ITEMS.search(l.text):
            l.tags.append("item?")
        if TODO.search(l.text):
            l.tags.append("todo?")
        if RULING.search(l.text):
            l.tags.append("ruling?")


# ---------------------------------------------------------------- Foundry chat log

def strip_html(s: str | None) -> str:
    s = re.sub(r"<br\s*/?>|</(p|div|li|h\d)>", "\n", s or "", flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


# Display names for common Foundry system ids; anything else is shown by its id or title.
SYSTEM_NAMES = {
    "pf1": "Pathfinder First Edition",
    "pf2e": "Pathfinder Second Edition",
    "D35E": "D&D 3.5",
    "dnd5e": "Dungeons & Dragons Fifth Edition",
    "a5e": "Level Up: Advanced 5th Edition",
    "sfrpg": "Starfinder",
    "sf2e": "Starfinder Second Edition",
    "swade": "Savage Worlds Adventure Edition",
    "wfrp4e": "Warhammer Fantasy Roleplay 4th Edition",
    "CoC7": "Call of Cthulhu 7th Edition",
    "shadowrun5e": "Shadowrun 5th Edition",
    "cyberpunk-red-core": "Cyberpunk RED",
    "ose": "Old-School Essentials",
    "archmage": "13th Age",
}


def game_system(sessions: list[dict]) -> dict | None:
    """The Foundry game system: as the module reported it (chatlog.json "system", module 0.5.0+),
    else inferred from system asset paths and compendium links in older chat logs."""
    for s in sessions:
        sysinfo = (s["chat"] or {}).get("system")
        if isinstance(sysinfo, dict) and sysinfo.get("id"):
            return {**sysinfo, "source": "Foundry"}
    seen: Counter = Counter()
    for s in sessions:
        for m in (s["chat"] or {}).get("messages", []):
            html = m.get("content") or ""
            seen.update(re.findall(r"\bsystems/([\w-]+)/", html))
            seen.update(x for x in re.findall(r"Compendium\.([\w-]+)\.", html) if x != "world")
    if not seen:
        return None
    return {"id": seen.most_common(1)[0][0], "title": None, "version": None, "source": "inferred from the chat log"}


def system_name(sysinfo: dict | None) -> str | None:
    if not sysinfo:
        return None
    return SYSTEM_NAMES.get(sysinfo["id"]) or sysinfo.get("title") or sysinfo["id"]


ITEM_NAME = re.compile(r'class="[^"]*\bitem-name\b[^"]*"[^>]*>(.*?)</', re.S)
CARD_TYPE = re.compile(r'card-header[^"]*\btype-([\w-]+)|data-item-type="([\w-]+)"')
NOT_POWERS = {"attack", "weapon", "equipment", "loot", "container", "consumable-ammo"}


def powers_used(sessions: list[dict]) -> list[dict]:
    """Spells and special abilities whose item cards Foundry posted, in order of first use:
    [{name, kind: spell|ability, users: [...]}]. Weapon attacks are left out."""
    found: dict[str, dict] = {}
    for s in sessions:
        for m in (s["chat"] or {}).get("messages", []):
            html = m.get("content") or ""
            if m.get("whisper") or "item-card" not in html:
                continue
            nm = ITEM_NAME.search(html)
            if not nm:
                continue
            name = re.sub(r"(\s*\([^)]*\))+\s*$", "", strip_html(nm.group(1))).strip()
            tm = CARD_TYPE.search(html)
            kind = (tm.group(1) or tm.group(2)).lower() if tm else ""
            if not name or kind in NOT_POWERS:
                continue
            kind = "spell" if kind == "spell" or re.search(r"<strong>School</strong>", html) else "ability"
            entry = found.setdefault(name.lower(), {"name": name, "kind": kind, "users": []})
            who = m.get("alias") or m.get("userName") or "Unknown"
            if who not in entry["users"]:
                entry["users"].append(who)
    return list(found.values())


GAP_HINT = ("some play here was not captured. Bridge it from what comes before and after; "
            "never mention the recording or the gap in the story (PROMPT.md, \"Gaps in the recording\")")


def foundry_events(sess: dict, offset: float):
    """Chat rolls, IC/OOC chat and combat start/end as stream lines, plus a facts digest."""
    chat = sess["chat"]
    if not chat:
        return [], []
    rel = lambda ms: (ms - sess["start_ms"]) / 1000 + offset
    events, facts = [], []
    dmg_by: Counter = Counter()
    for m in chat.get("messages", []):
        if m.get("whisper"):
            continue  # GM secrets stay secret
        who = m.get("alias") or m.get("userName") or "Unknown"
        t = rel(m["timestamp"])
        if m.get("isRoll") or m.get("rolls"):
            label = strip_html(m.get("flavor")) or strip_html(m.get("content"))[:120]
            rolls = "; ".join(f"{(r.get('flavor') + ': ') if r.get('flavor') else ''}{r['formula']} = {r.get('total', '?')}" for r in m.get("rolls", []))
            tag = ""
            if re.search(r"damage|healing", label + rolls, re.I):
                tag = " {dmg}"
                for r in m.get("rolls", []):
                    if isinstance(r.get("total"), (int, float)):
                        dmg_by[who] += r["total"]
            if re.search(r"\b(1d20|d20)\b", rolls) and re.search(r"= ?20\b", rolls):
                tag += " {nat20?}"
            events.append((t, f"[FOUNDRY ROLL] {who}: {label}{f' ({rolls})' if rolls else ''}{tag}"))
        else:
            text = strip_html(m.get("content"))
            if text:
                events.append((t, f"[FOUNDRY CHAT {'IC' if m.get('inCharacter') else 'OOC'}] {who}: {text[:600]}"))
    for c in chat.get("combats", []):
        name = c.get("name") or c.get("scene") or "Combat"
        vis = [x for x in c.get("combatants", []) if not x.get("hidden")]
        pcs = [x["name"] for x in vis if not x.get("isNPC")]
        foes = [x["name"] for x in vis if x.get("isNPC")]
        defeated = [x["name"] for x in vis if x.get("defeated")]
        if c.get("startedAt"):
            events.append((rel(c["startedAt"]), f"[FOUNDRY COMBAT START] {name}. Party: {', '.join(pcs) or '?'}. Opponents: {', '.join(foes) or '?'}."))
        if c.get("endedAt"):
            events.append((rel(c["endedAt"]), f"[FOUNDRY COMBAT END] {name} after {c.get('round', 0)} round(s). Defeated: {', '.join(defeated) or 'none'}."))
        facts.append(f"- Combat **{name}**: {c.get('round', 0)} round(s); party {', '.join(pcs) or '?'}; opponents {', '.join(foes) or '?'}; "
                     f"defeated {', '.join(defeated) or 'none'}{'' if c.get('endedAt') else ' (no end recorded)'}.")
    for who, total in dmg_by.most_common():
        facts.append(f"- Damage/healing rolled by {who}: {total:g} total (sum of damage-flavoured rolls).")
    n_msgs = len(chat.get("messages", []))
    facts.insert(0, f"- Chat log: {n_msgs} message(s), {len(chat.get('combats', []))} combat(s), world `{chat.get('world')}`.")
    return events, facts


# ---------------------------------------------------------------- campaign + people

def read_campaign():
    out = {}
    for name in ("context.md", "glossary.md"):
        p = REPO / "campaign" / name
        txt = p.read_text(encoding="utf-8") if p.exists() else ""
        out[name] = re.sub(r"<!--.*?-->", "", txt, flags=re.S).strip()
    names = set()
    for m in re.finditer(r"^\s*-\s*([^:\n]+)", out["glossary.md"], re.M):
        names.add(m.group(1).strip().lower())
    return out, names


def people(sessions: list[dict], db) -> list[dict]:
    """One entry per person at the table, with the real names they go by."""
    roster = {}
    if db is not None:
        try:
            for user, actor in db.execute("select user_name, actor_name from roster"):
                if actor:
                    roster[actor] = user
        except sqlite3.Error:
            pass
    chars = {w for s in sessions for p in s["participants"] for w in (p.get("character") or "").split()}
    seen, out = set(), []
    for s in sessions:
        for p in s["participants"]:
            if p["discordId"] in seen:
                continue
            seen.add(p["discordId"])
            fuser = roster.get(p.get("character") or "", "") if not p.get("isGm") else ""
            names = []
            for nm in (p["displayName"], fuser):
                for tok in re.split(r"[^\w'-]+", nm or ""):
                    # A character's own name is never a "real name" hint.
                    if len(tok) >= 3 and tok[:1].isupper() and tok.lower() not in {"among", "other", "the"} and tok not in chars:
                        names.append(tok)
            out.append({"discordId": p["discordId"], "displayName": p["displayName"], "isGm": bool(p.get("isGm")),
                        "character": None if p.get("isGm") else p.get("character"), "foundryUser": fuser,
                        "label": "GM" if p.get("isGm") else (p.get("character") or p["displayName"]),
                        "names": list(dict.fromkeys(names)), "nicknames": []})
    return out


# ---------------------------------------------------------------- nicknames

NICKNAMES_FILE = DATA / "nicknames.json"
ABSENT, NOT_PERSON = "absent", "not-a-person"
# Common English short forms, so "Robbie" can be suggested for a player called Robert.
DIMINUTIVES = {
    "james": "jim jimmy jamie jimbo", "anthony": "tony tone ant", "michael": "mike mikey mick", "robert": "bob bobby rob robbie bert",
    "william": "will bill billy liam", "richard": "rick ricky dick rich", "thomas": "tom tommy", "david": "dave davey",
    "christopher": "chris topher", "matthew": "matt matty", "nicholas": "nick nicky", "steven": "steve stevie",
    "stephen": "steve stevie", "joseph": "joe joey", "daniel": "dan danny", "benjamin": "ben benny", "samuel": "sam sammy",
    "alexander": "alex al xander", "andrew": "andy drew", "peter": "pete", "gregory": "greg", "jeffrey": "jeff",
    "kenneth": "ken kenny", "lawrence": "larry", "john": "jack johnny jon", "jonathan": "jon jonny", "edward": "ed eddie ted",
    "charles": "charlie chuck", "jason": "jay", "jeremy": "jerry jer", "neil": "neily", "jacob": "jake", "brett": "bretty",
    "elizabeth": "liz lizzy beth betty", "katherine": "kate katie kat", "jennifer": "jen jenny", "margaret": "maggie meg peggy",
    "rebecca": "becky becca", "jessica": "jess jessie", "victoria": "vicky tori", "patricia": "pat patty trish",
}
SHORT_TO_FULL = {short: full for full, shorts in DIMINUTIVES.items() for short in shorts.split()}
# Capitalised words that open a sentence or answer, never a name.
NOT_NAMES = set("""i i'm i'll i've i'd okay ok yeah yes yep yup no nope oh ah uh um hmm hey well so and but or now then
alright all right sure wait right good great nice cool fine god jesus man dude guys buddy sir mister mr mrs ms dm gm
what why who how where when which that this there here these those it it's its he she they we you your my me us
let let's thanks thank please sorry hello hi bye look see go come yo whoa wow damn shit fuck fucking hell lol
also actually anyway maybe just really very not never always one two three four five six seven eight nine ten
""".split())


def soundex(word: str) -> str:
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return ""
    w = re.sub(r"^c(?=[eiy])", "s", w)          # "Cyra" sounds like "Sira"
    codes = {**dict.fromkeys("bfpv", "1"), **dict.fromkeys("cgjkqsxz", "2"), **dict.fromkeys("dt", "3"),
             "l": "4", **dict.fromkeys("mn", "5"), "r": "6"}
    out, last = w[0], codes.get(w[0], "")
    for ch in w[1:]:
        c = codes.get(ch, "")
        if c and c != last:
            out += c
        if ch not in "hw":
            last = c
    return (out + "000")[:4]


# Spell lists and Whisper fragments are full of "Word, Word," so a capitalised word
# before a comma isn't enough. Each signal below needs evidence of a person.
CAP = re.compile(r"\b[A-Z][a-z]+\b")
SECOND_PERSON = re.compile(r"\b(you|your|you're|youre|yours|yourself|ya|y'all)\b", re.I)
LEAD_IN = re.compile(r"(?:^|[.!?,]\s*)(?:(?:and|so|okay|ok|alright|all right|hey|well|yeah|oh|now|um|uh)[\s,]+)*$", re.I)
STRONG_BEFORE = re.compile(r"\b(?:told by|asked by|tell|told|ask|asked|thank|thanks|is|isn't|where's|where is)\s+$", re.I)
STRONG_AFTER = re.compile(r"^(?:\s+(?:said|says|told|asked|wants|thinks|is here|isn't here|is back|here\?|there\?))", re.I)
VERB_AFTER = re.compile(r"^(?:'s|\s+(?:is|was|will|can|can't|has|had|gonna|wants|does|did|doesn't|said|says|needs|just|"
                        r"isn't|would|could|should|might|went|got|looks|sees|moves|casts|goes))\b", re.I)


def load_nicknames() -> dict:
    try:
        return json.loads(NICKNAMES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_nicknames(data: dict) -> None:
    NICKNAMES_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = NICKNAMES_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(NICKNAMES_FILE)


def resolve_owner(value: str, folks: list[dict]) -> dict | None:
    """Turn a confirmation value (character, GM, player name, absent, not-a-person) into a stored record."""
    v = value.strip()
    if v.lower() in (ABSENT, "absent", "not-at-table", "not at the table"):
        return {"is": ABSENT}
    if v.lower() in (NOT_PERSON, "not a person", "ignore", "none"):
        return {"is": NOT_PERSON}
    for p in folks:
        keys = {p["label"].lower(), p["displayName"].lower(), (p["character"] or "").lower(), (p["foundryUser"] or "").lower()}
        keys |= {n.lower() for n in p["names"]}
        if p["isGm"]:
            keys.add("gm")
        if v.lower() in keys:
            return {"is": "GM" if p["isGm"] else "player", "discordId": p["discordId"], "label": p["label"],
                    "displayName": p["displayName"]}
    return None


def find_nickname_candidates(lines: list[Line], folks: list[dict], glossary_names: set[str], known: set[str]):
    """Names that look like a real person being addressed or mentioned, with a guess at who."""
    by_id = {p["discordId"]: p for p in folks}
    words_of_chars = {w.lower() for p in folks for w in (p["character"] or "").split()}
    found: dict[str, dict] = {}
    kept = [l for l in lines if not l.drop]
    for i, l in enumerate(kept):
        text = l.text
        for m in CAP.finditer(text):
            name, before, after = m.group(0), text[:m.start()], text[m.end():]
            low = name.lower()
            if low in NOT_NAMES or low in words_of_chars or low in glossary_names or name in known or len(name) < 2:
                continue
            if len(name) > 9:   # full real names come from Discord/Foundry; long ones here are mishearings ("Fortnegates")
                continue
            sentence_start = bool(LEAD_IN.search(before))
            in_list = bool(re.search(r"[A-Z][a-z]+,\s*$", before) or re.match(r"^,\s*(?:and\s+)?[A-Z][a-z]", after))
            clause_after = re.split(r"[.!?]", after, maxsplit=1)[0]
            clause_before = re.split(r"[.!?]", before)[-1]
            # "Becca, I got to hit you" / "You done, Mal?" / "Are you down here, Robert?"
            addressed = not in_list and (
                (sentence_start and after.startswith(",") and bool(SECOND_PERSON.search(clause_after)))
                or (before.rstrip().endswith(",") and bool(re.match(r"^\s*[?.!]*\s*$", after)) and bool(SECOND_PERSON.search(clause_before))))
            strong = bool(STRONG_BEFORE.search(before) or STRONG_AFTER.match(after))   # "told by Morgan", "Is Sira here?"
            weak = not in_list and bool(VERB_AFTER.match(after))                        # "Robbie's gonna cast", "Robbie can look"
            mid = not sentence_start
            if not (addressed or strong or weak or mid):
                continue
            c = found.setdefault(name, {"name": name, "count": 0, "addressed": 0, "strong": 0, "weak": 0,
                                        "votes": Counter(), "why": {}, "evidence": []})
            c["count"] += 1
            c["strong"] += strong
            c["weak"] += weak
            ev = f"{l.id} [{fmt(l.t)}] {l.speaker}: {text.strip()[:140]}"
            if (addressed or strong or weak) and len(c["evidence"]) < 3 and ev not in c["evidence"]:
                c["evidence"].append(ev)
            how = "addressed" if addressed else "mentioned"
            if how == "addressed":
                c["addressed"] += 1
                # Whoever answers next (not the speaker) is probably the one addressed.
                nxt = next((n for n in kept[i + 1:i + 6] if n.discord_id != l.discord_id and n.t - l.end < 12), None)
                if nxt is not None:
                    c["votes"][nxt.discord_id] += 1
                    c["why"].setdefault(nxt.discord_id, set()).add("answers when the name is called")
    for c in found.values():
        low = c["name"].lower()
        for p in folks:
            for real in p["names"]:
                r = real.lower()
                if SHORT_TO_FULL.get(low) == r or SHORT_TO_FULL.get(low) == SHORT_TO_FULL.get(r, "?"):
                    c["votes"][p["discordId"]] += 3
                    c["why"].setdefault(p["discordId"], set()).add(f"common short form of {real}")
                elif len(low) >= 3 and (r.startswith(low[:3]) and len(low) <= len(r) + 1):
                    c["votes"][p["discordId"]] += 3
                    c["why"].setdefault(p["discordId"], set()).add(f"starts like {real}")
                elif soundex(low) == soundex(r):
                    c["votes"][p["discordId"]] += 3
                    c["why"].setdefault(p["discordId"], set()).add(f"sounds like {real}")
        c["suggest"] = None
        if c["votes"]:
            did, score = c["votes"].most_common(1)[0]
            if score >= 2 or c["addressed"] == 1:
                c["suggest"] = did
                c["reason"] = "; ".join(sorted(c["why"][did]))
        if c["suggest"] is not None:
            c["suggestLabel"] = by_id[c["suggest"]]["label"]
        elif c["addressed"] or c["strong"]:
            c["suggestLabel"] = ABSENT
            c["reason"] = "spoken to or about like a person, but nobody at the table answers to it"
        else:
            # Only ever "X is / X can / X's": as likely a companion, NPC or place as a person.
            c["suggestLabel"] = NOT_PERSON
            c["reason"] = "only talked about, never spoken to; could be a companion, NPC or place"
    # Keep a name only with real evidence of a person: addressed with "you", a clear
    # person cue ("told by X", "is X here?"), or mentioned mid-sentence at least twice
    # with a verb after it once. A lone capitalised word is usually a spell or a mishearing.
    keep = [c for c in found.values() if c["addressed"] or c["strong"] or (c["weak"] and c["count"] >= 2)]
    return sorted(keep, key=lambda c: -c["count"])


def report_unconfirmed(cands: list[dict], folks: list[dict], out: Path) -> None:
    """Print (and save as nicknames.md) what needs confirming, with a ready command per name."""
    md = ["# Names to confirm", "",
          "These names are used at the table but aren't a known Discord or Foundry name. Confirm who each one is,",
          "then run prepare.py again with the --nickname flags. Answers are saved in data/nicknames.json.", ""]
    print(f"NAMES TO CONFIRM ({len(cands)}): nothing written yet. Ask the user who each one is.")
    for c in cands:
        sug = c["suggestLabel"]
        md += [f"## {c['name']} ({c['count']}x)", "",
               f"- Suggested: **{sug}** ({c['reason']})", "- Evidence:", *[f"  - `{e}`" for e in c["evidence"]], ""]
        print(f"\n  {c['name']}  ({c['count']}x)  suggested: {sug}  ({c['reason']})")
        for e in c["evidence"]:
            print(f"      {e}")
    who = ", ".join(repr(p["label"]) for p in folks)
    flags = " ".join(f'--nickname "{c["name"]}={c["suggestLabel"]}"' for c in cands)
    md += ["## Answers", "", f"WHO is one of: {who}, `absent` (a real person not at the table), `not-a-person`.", "",
           "If every suggestion is right:", "", "```", flags, "```", ""]
    (out / "nicknames.md").write_text("\n".join(md), encoding="utf-8")
    print(f"\n  WHO is one of: {who}, 'absent' (real person not at the table), 'not-a-person'.")
    print(f"  If every suggestion is right, re-run with:\n  {flags}")
    print(f"  Details: {out / 'nicknames.md'}")


def ask_in_terminal(cands: list[dict], folks: list[dict]) -> dict:
    """When a human runs this in a terminal, ask about each name right here."""
    answers = {}
    opts = [p["label"] + (f" ({p['displayName']})" if p["label"] != p["displayName"] else "") for p in folks]
    for c in cands:
        print(f"\nWho is \"{c['name']}\"? ({c['count']}x in the transcript)")
        for e in c["evidence"]:
            print(f"    {e}")
        for k, o in enumerate(opts, 1):
            mark = "  <- suggested: " + c["reason"] if folks[k - 1]["discordId"] == c["suggest"] else ""
            print(f"  {k}) {o}{mark}")
        print(f"  a) a real person not at the table{'  <- suggested' if not c['suggest'] else ''}")
        print("  n) not a person (a character, creature, place or misheard word)")
        print("  s) skip for now")
        while True:
            try:
                ans = input("> ").strip().lower()
            except EOFError:      # not really interactive (Windows reports NUL as a tty)
                return answers
            if ans == "" and c["suggest"]:
                ans = str(1 + [p["discordId"] for p in folks].index(c["suggest"]))
            if ans.isdigit() and 1 <= int(ans) <= len(folks):
                answers[c["name"]] = folks[int(ans) - 1]["label"]
                break
            if ans in ("a", "n", "s"):
                if ans != "s":
                    answers[c["name"]] = ABSENT if ans == "a" else NOT_PERSON
                break
            print("  Pick a number, a, n or s.")
    return answers


# ---------------------------------------------------------------- output

def tag_names(lines: list[Line], owners: dict[str, str]) -> None:
    """Tag each line that uses a real name with whose it is, e.g. {names Becca = Alessandra Deiana's player}.
    The GM often addresses a player by name to mean their character ("Becca, I got to hit you")."""
    if not owners:
        return
    rx = re.compile(r"\b(" + "|".join(re.escape(n) for n in sorted(owners, key=len, reverse=True)) + r")\b")
    for l in lines:
        if l.drop:
            continue
        seen = []
        for m in rx.finditer(l.text):
            if m.group(1) not in seen:
                seen.append(m.group(1))
        if seen:
            l.tags.insert(0, "names " + ", ".join(f"{n} = {owners[n]}" for n in seen))


def stream_lines(lines: list[Line], events):
    items = [(l.t, f"{l.id} [{fmt(l.t)}] {l.speaker}: {l.text.strip()}" + (f"  {{{'; '.join(l.tags)}}}" if l.tags else ""))
             for l in lines if not l.drop]
    items += [(t, f"F [{fmt(t)}] {text}") for t, text in events]
    items.sort(key=lambda x: x[0])
    out, last = [], None
    for t, text in items:
        if last is not None and t - last > 300:
            out.append((t, f"-- [{fmt(t)}] {int((t - last) // 60)} minutes with no usable speech --"))
        out.append((t, text))
        last = t
    return out


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sessions", nargs="+")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--chunk-minutes", type=int, default=30)
    ap.add_argument("--nickname", action="append", default=[], metavar="NAME=WHO",
                    help="confirm who a name used at the table belongs to; saved in data/nicknames.json. "
                         "WHO is a character, GM, a player's name, 'absent' (a real person not at the table) or "
                         "'not-a-person'. Repeatable, e.g. --nickname \"Becca=Alessandra Deiana\"")
    ap.add_argument("--unconfirmed-ok", action="store_true",
                    help="write the pack even if some names are unconfirmed (they are then treated as real people)")
    ap.add_argument("--style", choices=["fantasy", "sci-fi"], default="fantasy",
                    help="voice of the story: high fantasy (default), or science fiction, which allows technical language")
    args = ap.parse_args()

    db = db_connect()
    resolved = [resolve_session(a, db) for a in args.sessions]
    camp, glossary_names = read_campaign()
    mapped = {}
    if db is not None:
        try:
            mapped = {d: (c, bool(g)) for d, c, g in db.execute("select discord_id, character_name, is_gm from mappings")}
        except sqlite3.Error:
            pass
    sessions = [load_session(sid, row, mapped) for sid, row in resolved]
    sessions.sort(key=lambda s: s["start_ms"])
    # Back-to-back sessions export overlapping chat logs. Keep each message and combat
    # once, from the latest export (a combat there has the most rounds).
    seen_msg, seen_combat = set(), set()
    for s in reversed(sessions):
        if s["chat"]:
            s["chat"]["messages"] = [m for m in s["chat"].get("messages", []) if m.get("id") not in seen_msg]
            s["chat"]["combats"] = [c for c in s["chat"].get("combats", []) if c.get("id") not in seen_combat]
            seen_msg |= {m.get("id") for m in s["chat"]["messages"]}
            seen_combat |= {c.get("id") for c in s["chat"]["combats"]}
    t0 = sessions[0]["start_ms"]

    all_lines: list[Line] = []
    events = []
    markers = []
    for s in sessions:
        off = (s["start_ms"] - t0) / 1000
        for l in s["lines"]:
            l.t += off
            l.end += off
            l.session = s["row"].get("number")
        all_lines += s["lines"]
        events += foundry_events(s, off)[0]
        if s is not sessions[0]:
            markers.append((off, f"[RECORDING RESUMED as session {s['row'].get('number')}: {GAP_HINT}]"))
        for g in s.get("gaps", []):
            markers.append((g + off, f"[RECORDING GAP: {GAP_HINT}]"))
    events += markers
    all_lines.sort(key=lambda l: l.t)
    for i, l in enumerate(all_lines, 1):
        l.id = f"L{i:04d}"

    folks = people(sessions, db)
    characters = {p["character"] for s in sessions for p in s["participants"] if p.get("character")}
    classify(all_lines, glossary_names, characters)

    # Names the table uses for real people: confirmed by the user, never guessed.
    nick = load_nicknames()
    before = json.dumps(nick, sort_keys=True)
    bad = []
    for spec in args.nickname:
        name, sep, who = spec.partition("=")
        rec = resolve_owner(who, folks) if sep and name.strip() else None
        if rec is None:
            bad.append(spec)
        else:
            nick[name.strip()] = rec
    if bad:
        sys.exit("Could not read --nickname " + ", ".join(repr(b) for b in bad) + ". Use NAME=WHO, where WHO is one of: "
                 + ", ".join(repr(p["label"]) for p in folks) + ", 'absent', 'not-a-person'.")
    known = {n for p in folks for n in p["names"]} | set(nick)
    cands = find_nickname_candidates(all_lines, folks, glossary_names, known)
    if cands and sys.stdin.isatty() and sys.stdout.isatty() and not args.unconfirmed_ok:
        for name, who in ask_in_terminal(cands, folks).items():
            nick[name] = resolve_owner(who, folks)
        cands = [c for c in cands if c["name"] not in nick]
    if json.dumps(nick, sort_keys=True) != before:
        save_nicknames(nick)

    by_id = {p["discordId"]: p for p in folks}
    owners = {}   # real name -> whose it is, for the tags
    for p in folks:
        for n in p["names"]:
            owners[n] = "the GM" if p["isGm"] else f"{p['label']}'s player"
    absent = []
    player_names = {n for p in folks for n in p["names"]}   # fine out of character, never in the story
    for name, rec in nick.items():
        if rec["is"] in ("player", "GM") and rec.get("discordId") in by_id:
            p = by_id[rec["discordId"]]
            p["nicknames"].append(name)
            owners[name] = "the GM" if p["isGm"] else f"{p['label']}'s player"
            player_names.add(name)
        elif rec["is"] == ABSENT:
            absent.append(name)
            owners[name] = "a real person not at the table"
    for c in cands:   # still unconfirmed (only with --unconfirmed-ok): play safe, treat as real
        owners[c["name"]] = "unconfirmed, treat as a real person"
    tag_names(all_lines, owners)
    real_names = set(owners)
    people_rows = [f"| {'GM (narrator and every NPC)' if p['isGm'] else (p['character'] or '(unmapped)')} | "
                   f"{'the GM' if p['isGm'] else p['displayName']} | {p['displayName']} | "
                   f"{p['foundryUser'] or '-'} | {', '.join(p['nicknames']) or '-'} |" for p in folks]
    actors, actors_source = foundry_actors([s["id"] for s in sessions])
    sheets = foundry_sheets(actors)
    char_rows = [{"character": p["character"], "player": p["displayName"], **sheets.get(p["character"], {"classes": [], "level": None})}
                 for p in folks if not p["isGm"] and p["character"]]
    char_rows.sort(key=lambda r: r["character"])
    no_sheet = [r["character"] for r in char_rows if not r["classes"] and r["level"] is None]

    kept = [l for l in all_lines if not l.drop]
    halluc = [l for l in all_lines if l.drop and not l.filler]
    fillers = [l for l in all_lines if l.filler]
    stream = stream_lines(all_lines, events)

    # Sheet details for the party, and for every NPC actor named in the session's speech or chat.
    party = {r["character"] for r in char_rows}
    said = "\n".join(text for _, text in stream)
    pc_details = sorted((a for a in actors if a.get("name") in party), key=lambda a: a["name"])
    npc_details = sorted((a for a in actors if a.get("name") and a["name"] not in party and a.get("type") != "character"
                          and has_details(a) and mentioned(a["name"], said)), key=lambda a: a["name"])[:40]

    first = sessions[0]
    out = args.out or (SESSIONS / first["id"] / "story")
    (out / "chunks").mkdir(parents=True, exist_ok=True)
    if cands and not args.unconfirmed_ok:
        report_unconfirmed(cands, folks, out)
        sys.exit(2)
    for old in (out / "chunks").glob("*.md"):
        old.unlink()

    numbers = ", ".join(f"#{s['row'].get('number', '?')} ({s['id']})" for s in sessions)
    last = sessions[-1]
    span = ((last["end_ms"] or (last["start_ms"] + 1000 * max((l.end for l in last["lines"]), default=0))) - t0) / 1000
    notes = []
    for s in sessions:
        if not s["end_ms"]:
            notes.append(f"- Session #{s['row'].get('number')} has no end time: the recording was interrupted (bot crash), so the record stops mid-scene. Close the story on the last moment it supports, as a natural pause, without mentioning the recording, at {fmt(max((l.end for l in s['lines']), default=0) + (s['start_ms'] - t0) / 1000)}.")
        if not s["chat"]:
            notes.append(f"- Session #{s['row'].get('number')} has no Foundry chat log: no dice totals or combat tracker data. Judge how big a moment was from what people said.")
        notes.append(f"- Session #{s['row'].get('number')} text comes from {s['source']}.")

    facts = []
    for s in sessions:
        facts += foundry_events(s, (s["start_ms"] - t0) / 1000)[1]
    sysinfo = game_system(sessions)
    sysname = system_name(sysinfo)
    powers = powers_used(sessions)
    style_lines = [
        ("High fantasy, told in clear, modern English: vivid, but no old-fashioned or archaic wording. "
         "No engineering, software or game-mechanics language."
         if args.style == "fantasy" else
         "Science fiction. Technical and engineering language is fine where it fits the setting; game-mechanics language still is not."),
        "",
    ]
    if sysname:
        ver = f", version {sysinfo['version']}" if sysinfo.get("version") else ""
        style_lines += [
            f"**Game system: {sysname}** (Foundry system `{sysinfo['id']}`{ver}; {sysinfo['source']}).",
            "",
            f"Capture the flavor of {sysname} without breaking the story's flow. Tell magic mostly by its effect. "
            f"Name a spell, with its {sysname} name as a proper noun, only where it is a one-off that turns the scene "
            "(the killing spell, the spell that ends the fight, a monster's signature power). Preparations, standing "
            "protections, utility spells and repeat castings are told by what they did. Never list spell names: at most "
            "one in a sentence. Never use an archaic stand-in (\"a folding spell\"), and leave out a spell's numbers.",
            "",
        ]
    else:
        style_lines += ["Game system: unknown (no Foundry chat log). Still call spells and abilities by the names the table uses for them.", ""]
    if powers:
        style_lines += ["Spells and abilities Foundry recorded (their exact names, for the ones worth naming):", ""]
        style_lines += [f"- {p['name']} ({p['kind']}; {', '.join(p['users'])})" for p in powers]
        style_lines.append("")

    reasons = Counter(re.sub(r"^\d+ words in [\d.]+s", "many words in a tiny clip", re.sub(r" ?\(.*?\)", "", l.drop)) for l in halluc)
    header = [
        f"# Evidence pack: session {numbers}",
        "",
        f"Started {datetime.fromtimestamp(t0 / 1000).astimezone().strftime('%Y-%m-%d %H:%M %Z')}, about {int(span // 60)} minutes recorded. "
        f"{len(all_lines)} transcribed lines: {len(kept)} kept, {len(halluc)} dropped as transcription hallucinations, {len(fillers)} dropped as filler/laughter.",
        "",
        "## People at the table",
        "",
        "| In the story | Player (out of character) | Discord name | Foundry user | Also called (confirmed) |",
        "|---|---|---|---|---|",
        *people_rows,
        "",
        *([f"Real people mentioned who are not at the table: {', '.join(sorted(absent))}. Leave them, and whatever was said about them, out of every section.", ""] if absent else []),
        *([f"Names not yet confirmed (treat as real people): {', '.join(c['name'] for c in cands)}.", ""] if cands else []),
        "Names in the right four columns are real people. Never use them in the story sections. Out-of-character notes "
        "(\"At the table\") refer to a player by the \"Player (out of character)\" name. "
        "People not at the table appear nowhere. A line tagged `names X = Y's player` "
        "is aimed at that player: often table talk, but when the GM says \"Becca, it hits you\" it means Y's character.",
        "",
        "## Characters in Session (from Foundry; copy this table as is)",
        "",
        *layout.character_table(char_rows),
        "",
        *([f"No class or level synced from Foundry for: {', '.join(no_sheet)}. Write \"{layout.UNKNOWN}\" unless the "
           "stream states it plainly (\"I'm a level 7 rogue\").", ""] if no_sheet else []),
        f"## Character and NPC details (from Foundry sheets; {actors_source})",
        "",
        "Background for the writer, not text to copy. Use race, sex/gender and age to describe people and to choose "
        "pronouns; use height and weight only as the eye would see them (\"towering\", \"slight\"). Max HP says how "
        "hardy someone is (a foe with many times a hero's is a terror); never write the number or the words \"hit points\".",
        "",
        "### The party",
        "",
        *(details_table(pc_details) if any(has_details(a) for a in pc_details)
          else ["(no sheet details synced for the party yet: the Foundry module needs updating)"]),
        "",
        "### NPCs named this session",
        "",
        *(details_table(npc_details) if npc_details else ["(none of the NPCs in Foundry are named in this session)"]),
        "",
        "## Style",
        "",
        *style_lines,
        "## Campaign context",
        "",
        camp["context.md"] or "(none)",
        "",
        "## Glossary (correct spellings for misheard names)",
        "",
        camp["glossary.md"] or "(none)",
        "",
        "## Foundry facts",
        "",
        *(facts or ["- No chat log for these sessions."]),
        "",
        "## Recording notes",
        "",
        *notes,
        "",
        "## Noise already removed",
        "",
        *[f"- {c}x {r}" for r, c in reasons.most_common()],
        f"- {len(fillers)}x filler sounds or laughter",
        "- Full list with reasons: `noise.md`. Rescue a line only if the story clearly needs it.",
        "",
        "## How to read the stream",
        "",
        "`L0123 [HH:MM:SS] Speaker: text  {tags}`. Use the IDs to find and check lines, but never write them in the story. `F` lines come from Foundry and are reliable. Tags are hints from cheap pattern matching, not verdicts:",
        "`ooc?` maybe table talk · `mech` rules/dice talk · `dmg` damage, healing, downs · `item?` maybe an item · `thanks-real?`/`short` a silence phrase kept because context allows it · "
        "`todo?` maybe a follow-up (a fix, homework, scheduling, a promise) · `ruling?` a rules question or ruling · `noise?` a few capitalised words on a tiny clip, often a name Whisper pulled out of noise · `timing?` too many words for the clip, check it fits · `repeated xN?` same short phrase many times · `loop-collapsed` decoder loop shortened · `low-confidence` Whisper was unsure.",
        "",
    ]

    def chunk_text(entries):
        return "\n".join(text for _, text in entries)

    span_s = args.chunk_minutes * 60
    chunks, cur, start = [], [], None
    for t, text in stream:
        if start is None:
            start = t
        if t - start >= span_s and cur:
            chunks.append(cur)
            cur, start = [], t
        cur.append((t, text))
    if cur:
        chunks.append(cur)

    pack = header + ["## Stream", ""] + [chunk_text(stream)]
    (out / "pack.md").write_text("\n".join(pack) + "\n", encoding="utf-8")
    short_header = header[: header.index("## Campaign context")] + header[header.index("## Glossary (correct spellings for misheard names)"):]
    for i, c in enumerate(chunks, 1):
        body = short_header + [f"## Stream, part {i} of {len(chunks)} ({fmt(c[0][0])} to {fmt(c[-1][0])})", "", chunk_text(c)]
        (out / "chunks" / f"{i:02d}.md").write_text("\n".join(body) + "\n", encoding="utf-8")

    noise = ["# Lines dropped as noise", "", "| ID | Time | Speaker | Text | Why |", "|---|---|---|---|---|"]
    for l in all_lines:
        if l.drop:
            txt = l.text.strip().replace("|", "\\|")[:160]
            noise.append(f"| {l.id} | {fmt(l.t)} | {l.speaker} | {txt} | {l.drop} |")
    (out / "noise.md").write_text("\n".join(noise) + "\n", encoding="utf-8")

    (out / "lines.json").write_text(json.dumps({
        "sessions": [{"id": s["id"], "number": s["row"].get("number")} for s in sessions],
        "characters": sorted({p.get("character") for s in sessions for p in s["participants"] if p.get("character")}),
        "realNames": sorted(real_names),
        "playerNames": sorted(player_names),
        "offTableNames": sorted(real_names - player_names),
        "style": args.style,
        "gameSystem": sysinfo and {**sysinfo, "name": sysname},
        "spellsUsed": [p["name"] for p in powers if p["kind"] == "spell"],
        "characterRows": char_rows,
        "actorDetails": {"source": actors_source, "party": pc_details, "npcs": npc_details},
        "lines": [{"id": l.id, "t": fmt(l.t), "speaker": l.speaker, "discordId": l.discord_id, "text": l.text, "dropped": l.drop,
                   "tags": l.tags}
                  for l in all_lines],
    }, ensure_ascii=False, indent=0), encoding="utf-8")

    date = datetime.fromtimestamp(t0 / 1000).astimezone().strftime("%Y-%m-%d")
    nums = " + ".join(str(s["row"].get("number", "?")) for s in sessions)
    byline = f"Session {nums} · {date} · about {int(span // 60)} minutes · " + ", ".join(r["character"] for r in char_rows)
    tmpl = layout.template(byline, char_rows)
    # The story starts as the filled-in template. Never overwrite a story already being written.
    story_path = out / "summary.story.md"
    seeded = not story_path.exists()
    if seeded:
        story_path.write_text(tmpl, encoding="utf-8")
    stale = out / "template.md"   # older runs wrote the skeleton here; the story file replaces it
    if stale.exists():
        stale.unlink()

    prompt = (SKILL_DIR / "PROMPT.md").read_text(encoding="utf-8")
    (out / "prompt-full.md").write_text(prompt + "\n\n---\n\n" + "\n".join(pack)
                                        + "\n\n---\n\n# Template: fill this in, keeping every heading in this order\n\n"
                                        + tmpl, encoding="utf-8")

    size = (out / "pack.md").stat().st_size
    print(f"sessions   {numbers}")
    print(f"lines      {len(all_lines)} total, {len(kept)} kept, {len(halluc)} hallucinations dropped, {len(fillers)} fillers dropped")
    for r, c in reasons.most_common():
        print(f"           {c:4d}  {r}")
    print(f"foundry    {len(events) - len(markers)} events from chat logs")
    print(f"out        {out}")
    print(f"pack.md    {size // 1024} KB (~{size // 4000}k tokens); {len(chunks)} chunk(s) of ~{args.chunk_minutes} min in chunks/")
    if seeded:
        print(f"story      summary.story.md started from template.md ({args.style}): fill in every <note>")
    else:
        print("story      summary.story.md already exists and was left as it is; rename or delete it "
              "to start a fresh one from template.md")
    print(f"actors     {len(pc_details)} party, {len(npc_details)} NPC sheet(s) from {actors_source}")
    if no_sheet:
        print(f"WARN       no class/level from Foundry for {', '.join(no_sheet)}: update the ScribBot module in Foundry "
              "and let the GM's client reconnect (or edit a sheet) so the roster re-syncs, then re-run")


if __name__ == "__main__":
    main()
