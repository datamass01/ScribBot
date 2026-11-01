#!/usr/bin/env python3
"""Check a session story written from an evidence pack, whichever model wrote it.

  python verify.py <story.md> [--lines <lines.json>]

<lines.json> defaults to the one next to the story (prepare.py writes both into
the same story/ folder). Fails (exit 1) when:
  - a quote is not in the transcript (fewer than 80% of its words, in order, in one
    to three consecutive lines from the same speaker): invented or paraphrased;
  - a quote matches a line prepare.py dropped as a hallucination;
  - a cited line ID does not exist or points at a dropped line;
  - a real person's name (Discord or Foundry user, nickname, or --real-name) appears
    in the story sections (everything above "## At the table");
  - the name of someone not at the table appears anywhere;
  - the story sections report damage, hit points or dice numbers;
  - a section is missing, repeated, unexpected or out of order (layout.SECTIONS);
  - "High level summary" is over 800 characters;
  - "Characters in Session" lacks the Character | Class(es) | Level | Player table, a
    character, or disagrees with Foundry's class/level;
  - "NPCs in Session" or "Objectives Completed" is empty;
  - a high-fantasy story (the default style) uses engineering or game-mechanics words
    outside quotes;
Warns when a quote has no line ID, a cite is far from where the quote really is,
the story sections mention players or the GM, or a player character is missing
from "Deeds of the party". Player names are allowed in "Characters in Session" (the
Player column), "At the table", "Action items" and "Chronicler's notes".
Standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import layout  # noqa: E402  (section order and limits, shared with prepare.py)

SECTIONS = layout.SECTIONS
# Private life that must not reach the table summary (see PROMPT.md section 7).
PRIVATE = re.compile(r"\b(wife|husband|girlfriend|boyfriend|daughter|son|kids?|dad|mom|mother|father|sick|stomach|"
                     r"illness|doctor|hospital|nyquil|smok(e|ing)|cigarette|beer|drunk|job|boss|thailand|phone call|"
                     r"car|driv(e|es|ing)|commute|pick(ing|ed)? up|errand|dinner|lunch|food)\b", re.I)
# Game numbers that must not appear on the story side (PROMPT.md: describe the moment, not the number).
_N = r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty)"
NUMBERS = re.compile(rf"\b{_N}[\s-]*(points?\s+of\s+)?(damage|dmg|hp|hit\s+points?|healing)\b"
                     rf"|\b(nat(ural)?|rolled(\s+an?)?)\s*{_N}\b"
                     r"|\b(AC|DC|touch|initiative)\s*(of\s+)?\d+\b|\b\d*d(4|6|8|10|12|20|100)\b|\bhit\s+points?\b|\b\d+\s+to\s+hit\b", re.I)
# Out-of-character references that don't belong in the story sections.
META = re.compile(r"\b(players?|the GM|game ?master|dungeon master|the table)\b", re.I)


def tokens(s: str) -> list[str]:
    s = s.lower().replace("’", "'").replace("'", "")
    s = re.sub(r"\b(um+|uh+|er+|ah+)\b", " ", s)
    return [w for w in re.sub(r"[^\w\s]", " ", s).split() if w]


def lcs(a: list[str], b: list[str]) -> int:
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("story", type=Path)
    ap.add_argument("--lines", type=Path)
    ap.add_argument("--real-name", action="append", default=[])
    ap.add_argument("--threshold", type=float, default=0.8)
    args = ap.parse_args()

    data = json.loads((args.lines or args.story.parent / "lines.json").read_text(encoding="utf-8"))
    story = args.story.read_text(encoding="utf-8")
    lines = data["lines"]
    index = {l["id"]: i for i, l in enumerate(lines)}

    # Kept lines: windows of 1-3 consecutive lines from one speaker (Whisper splits
    # sentences at pauses). Dropped lines are checked one at a time, separately.
    kept = [i for i, l in enumerate(lines) if not l["dropped"]]
    windows = []  # (index of first line, tokens)
    for a, i in enumerate(kept):
        toks = []
        for k in kept[a:a + 3]:
            if lines[k]["discordId"] != lines[i]["discordId"]:
                break
            toks = toks + tokens(lines[k]["text"])
            windows.append((i, toks))
    dropped_windows = [(i, tokens(l["text"])) for i, l in enumerate(lines) if l["dropped"]]

    def best_match(qt, wins):
        best, at = 0.0, None
        for i, wt in wins:
            score = lcs(qt, wt) / len(qt)
            if score > best:
                best, at = score, i
            if score == 1:
                break
        return best, at

    fails, warns = [], []

    # Layout: every section, exactly once, in layout.SECTIONS order, with nothing extra between them.
    found = layout.headings(story)
    low = [h.lower() for h in found]
    for name in SECTIONS:
        n = low.count(name.lower())
        if n == 0:
            fails.append(f"missing section: ## {name}")
        elif n > 1:
            fails.append(f"section appears {n} times: ## {name}")
    extra = [h for h in found if h.lower() not in {s.lower() for s in SECTIONS}]
    for h in extra:
        fails.append(f"unexpected section: ## {h} (sections are fixed; see template.md)")
    present = [h for h in low if h in {s.lower() for s in SECTIONS}]
    expected = [s.lower() for s in SECTIONS if s.lower() in present]
    if present != expected:
        fails.append("sections out of order: expected " + " → ".join(s for s in SECTIONS if s.lower() in present))
    if not re.search(r"^---\s*$(?=\s*^##\s+At the table\s*$)", story, re.M | re.I):
        warns.append('put a "---" line just before "## At the table" to separate the story from the table notes')

    summary = re.sub(r"\s+", " ", re.sub(r"\[L\d{4}\]", "", layout.section(story, "High level summary"))).strip()
    if not summary:
        fails.append("High level summary is empty")
    elif len(summary) > layout.SUMMARY_MAX_CHARS:
        fails.append(f"High level summary is {len(summary)} characters; the limit is {layout.SUMMARY_MAX_CHARS}")

    roster = layout.section(story, "Characters in Session")
    head = re.search(r"^\|(.+)\|\s*$", roster, re.M)
    cols = [c.strip().lower() for c in head.group(1).split("|")] if head else []
    if cols != [c.lower() for c in layout.CHARACTER_COLUMNS]:
        fails.append("Characters in Session needs a table with columns: " + " | ".join(layout.CHARACTER_COLUMNS))
    rows = {}
    for r in re.findall(r"^\|(.+)\|\s*$", roster, re.M)[2:]:
        cells = [c.strip() for c in r.split("|")]
        if len(cells) == len(layout.CHARACTER_COLUMNS):
            rows[cells[0]] = cells
    for want in data.get("characterRows", []):
        got = rows.get(want["character"])
        if not got:
            fails.append(f"Characters in Session is missing {want['character']}")
            continue
        exp = [want["character"], layout.class_text(want.get("classes", [])),
               str(want["level"]) if want.get("level") is not None else layout.UNKNOWN, want["player"]]
        for col, e, g in zip(layout.CHARACTER_COLUMNS[1:], exp[1:], got[1:]):
            if e != layout.UNKNOWN and g != e:
                fails.append(f"Characters in Session: {want['character']} {col} is '{g}', Foundry says '{e}'")

    npcs = layout.section(story, "NPCs in Session")
    if not re.search(r"^- \*\*[^*]+:\*\*\s+\S", npcs, re.M) and "none this session" not in npcs.lower():
        fails.append('NPCs in Session: list "- **Name:** their part", or write "None this session."')
    objectives = layout.section(story, "Objectives Completed")
    if not re.search(r"^- \S", objectives, re.M) and "none this session" not in objectives.lower():
        fails.append('Objectives Completed is empty: list what the party achieved, or write "None this session."')

    for cid in sorted(set(re.findall(r"\bL\d{4}\b", story))):
        if cid not in index:
            fails.append(f"{cid}: cited but no such line")
        elif lines[index[cid]]["dropped"]:
            fails.append(f"{cid}: cited, but prepare.py dropped it as noise ({lines[index[cid]]['dropped']})")

    notes = re.search(r"^##\s+Chronicler's notes\s*$", story, re.M | re.I)
    checked = story[:notes.start()] if notes else story  # the notes may quote noise on purpose
    quotes = []
    for m in re.finditer(r"“([^”]+)”|\"([^\"\n]+)\"", checked):
        q = m.group(1) or m.group(2)
        if len(tokens(q)) < 3:
            continue
        tail = story[m.end():m.end() + 200].split("\n\n")[0]
        if story[m.end():].startswith("\n"):
            tail = story[m.end():m.end() + 200]   # block quote: cite is on the "—" line below
        cite = re.search(r"\bL\d{4}\b", tail)
        quotes.append((q, cite.group(0) if cite else None))

    ok = 0
    for q, cite in quotes:
        qt = tokens(q)
        best, at = best_match(qt, windows)
        short = q if len(q) < 70 else q[:67] + "..."
        if best < args.threshold:
            dbest, dat = best_match(qt, dropped_windows)
            if dbest >= args.threshold:
                fails.append(f"quote matches a line dropped as noise ({lines[dat]['id']}: {lines[dat]['dropped']}): “{short}”")
            else:
                fails.append(f"quote not in transcript ({best:.0%} match): “{short}”")
            continue
        ok += 1
        if not cite:
            warns.append(f"quote has no line ID; it is {lines[at]['id']}: “{short}”")
        elif cite in index and abs(index[cite] - at) > 3:
            warns.append(f"quote cites {cite} but is {lines[at]['id']}: “{short}”")

    # Story side: everything above "## At the table". It is told in character only.
    table_at = re.search(r"^##\s+At the table\s*$", story, re.M | re.I)
    story_side = story[:table_at.start()] if table_at else story
    table_side = story[table_at.start():] if table_at else ""
    # The character roster names each player on purpose; check it only for off-table names.
    for name in layout.PLAYER_NAMES_ALLOWED:
        allowed = layout.section(story_side, name)
        if allowed:
            story_side = story_side.replace(allowed, "\n", 1)
            table_side += allowed
    real = set(data.get("realNames", [])) | set(args.real_name)
    off_table = set(data.get("offTableNames", real)) | set(args.real_name)   # older lines.json: all real names
    for name in sorted(real):
        hits = re.findall(rf"\b{re.escape(name)}\b", story_side)
        if hits:
            fails.append(f"real name in the story sections: {name} ({len(hits)}x); use the character's name")
    for name in sorted(off_table):
        hits = re.findall(rf"\b{re.escape(name)}\b", table_side)
        if hits:
            fails.append(f"name of someone not at the table: {name} ({len(hits)}x); leave them out entirely")

    def line_of(text, pos):
        return text[text.rfind("\n", 0, pos) + 1:].split("\n")[0].strip()[:80]

    for m in NUMBERS.finditer(story_side):
        fails.append(f"game numbers in the story sections ('{m.group(0)}'), describe the moment instead: {line_of(story_side, m.start())}")
    for m in META.finditer(story_side):
        warns.append(f"story sections mention the table ('{m.group(0)}'), keep it in character: {line_of(story_side, m.start())}")
    if data.get("style", "fantasy") == "fantasy":
        prose = re.sub(r"“[^”]*”|\"[^\"\n]*\"", " ", story_side)   # quotes are verbatim; judge only our own words
        for m in layout.JARGON.finditer(prose):
            fails.append(f"engineering or game-mechanics wording ('{m.group(0)}') in a high-fantasy tale; "
                         f"tell it as a bard would: {line_of(prose, m.start())}")

    def section(name):
        return layout.section(story, name)

    table = section("At the table")
    for word in sorted({w.lower() for w in PRIVATE.findall(table) for w in ([w] if isinstance(w, str) else [w[0]])}):
        warns.append(f"At the table mentions private life ('{word}'): keep only what matters to the game")
    actions = section("Action items")
    items = [l.strip() for l in actions.splitlines() if l.strip().startswith("- ")]
    if not items and "none this session" not in actions.lower():
        fails.append('Action items is empty: list items or write "None this session."')
    for it in items:
        if not re.match(r"^- \[[ xX]\] \*\*[^*]+:\*\*\s+\S", it):
            fails.append(f"action item needs '- [ ] **Owner:** task': {it[:80]}")
        elif not re.search(r"\bL\d{4}\b", it):
            warns.append(f"action item has no line ID: {it[:80]}")

    deeds = section("Deeds of the party")
    for c in data.get("characters", []):
        if deeds and c.split()[0] not in deeds:
            warns.append(f"player character missing from Deeds of the party: {c}")

    print(f"quotes     {ok} of {len(quotes)} verified")
    print(f"citations  {len(set(re.findall(r'\bL\d{4}\b', story)))} distinct line IDs")
    for w in warns:
        print(f"WARN  {w}")
    for f in fails:
        print(f"FAIL  {f}")
    print("PASS" if not fails else f"{len(fails)} problem(s): fix the story and run verify.py again")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
