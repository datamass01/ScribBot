#!/usr/bin/env python3
"""Check a session story written from an evidence pack, whichever model wrote it.

  python verify.py <story.md> [--lines <lines.json>]

<lines.json> defaults to the one next to the story (prepare.py writes both into
the same story/ folder). Fails (exit 1) when:
  - a quote is not in the transcript (fewer than 80% of its words, in order, in one
    to three consecutive lines from the same speaker): invented or paraphrased;
  - a quote matches a line prepare.py dropped as a hallucination;
  - the document contains line IDs ([L0123]): they are for the writer, not the reader;
  - "The story" has subheadings (it is one continuous tale);
  - a real person's name (Discord or Foundry user, nickname, or --real-name) appears
    in the story sections (everything above "## At the table");
  - the name of someone not at the table appears anywhere;
  - the story sections report damage, hit points or dice numbers;
  - a section is missing, repeated, unexpected or out of order (layout.SECTIONS);
  - "High level summary" is over 800 characters;
  - "Characters in Session" lacks the Character | Class(es) | Level | Player table, a
    character, or disagrees with Foundry's class/level;
  - "NPCs in Session" lacks the NPC | Race | Class(es) | Level | Part in the session table
    (or "None this session."), lists a player character, leaves a part empty, or disagrees
    with an NPC's Foundry sheet; "Objectives Completed" is empty;
  - a high-fantasy story (the default style) uses engineering or game-mechanics words
    outside quotes;
Warns when a quote comes from a line tagged dmg/mech/ooc?, is the GM's narration credited
to a character, or reads like a player describing an action ("I grit as my body…")
instead of speech; when a paragraph of "The story" runs past 180 words; when the story
sections mention players or the GM; when an NPC row's name is only a creature kind or a
role ("Duergar Taskmaster"); or when a player character is missing from "Deeds of the
party". It prints the source line of every verified quote. Player names are allowed in
"Characters in Session" (the Player column), "At the table" and "Chronicler's notes".
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
# A quote that is a player narrating their character ("I grit as my body…", "I cast…") rather
# than the character speaking. A hint only: a character can say "I cast you out!" aloud.
DESCRIBED = re.compile(r"^\W*I\s+(grit|manage|try|attempt|cast|attack|move|roll|kick|throw|swing|shoot|fire|"
                       r"step|run|fly|use|grab|search|charge|dodge|duck|leap|jump|climb|sneak|hide)\b|\bmy body\b",
                       re.I)
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

    # NPCs: a table of named NPCs, like the character roster. Generic monsters belong to "Battles".
    npcs = layout.section(story, "NPCs in Session")
    npc_head = re.search(r"^\|(.+)\|\s*$", npcs, re.M)
    npc_cols = [c.strip().lower() for c in npc_head.group(1).split("|")] if npc_head else []
    if not npc_head and "none this session" not in npcs.lower():
        fails.append("NPCs in Session needs a table with columns: " + " | ".join(layout.NPC_COLUMNS)
                     + ', or "None this session."')
    elif npc_head and npc_cols != [c.lower() for c in layout.NPC_COLUMNS]:
        fails.append("NPCs in Session table columns must be: " + " | ".join(layout.NPC_COLUMNS))
    elif npc_head:
        foundry = {a["name"].lower(): a for a in data.get("actorDetails", {}).get("npcs", [])}
        races = {w for a in foundry.values() for w in re.findall(r"[a-z]+", (a.get("race") or "").lower())}
        generic = layout.GENERIC_NAME_WORDS | races
        party = {c.lower() for c in data.get("characters", [])}
        for r in re.findall(r"^\|(.+)\|\s*$", npcs, re.M)[2:]:
            cells = [c.strip() for c in r.split("|")]
            if len(cells) != len(layout.NPC_COLUMNS):
                fails.append(f"NPCs in Session: row needs {len(layout.NPC_COLUMNS)} cells: |{r[:60]}|")
                continue
            name = cells[0].strip("*")
            words = re.findall(r"[a-z']+", name.lower())
            if name.lower() in party:
                fails.append(f"NPCs in Session: {name} is a player character; they belong in Characters in Session")
            elif not words or all(w in generic for w in words):
                warns.append(f"NPCs in Session: '{name}' reads as a kind of creature or a role, not a name; "
                             f"list only named NPCs and leave monsters to the Foes in Battles")
            if not cells[4] or cells[4].startswith("<"):
                fails.append(f"NPCs in Session: {name} needs their part in the session")
            a = foundry.get(name.lower())
            if a:   # an NPC with a Foundry sheet: its race, class and level come from it
                lvl = str(a["level"]) if a.get("classes") and a.get("level") is not None else layout.UNKNOWN
                for col, e, g in (("Race", a.get("race") or layout.UNKNOWN, cells[1]),
                                  ("Class(es)", layout.class_text(a.get("classes", [])), cells[2]),
                                  ("Level", lvl, cells[3])):
                    if e != layout.UNKNOWN and g != e:
                        fails.append(f"NPCs in Session: {name} {col} is '{g}', Foundry says '{e}'")
    objectives = layout.section(story, "Objectives Completed")
    if not re.search(r"^- \S", objectives, re.M) and "none this session" not in objectives.lower():
        fails.append('Objectives Completed is empty: list what the party achieved, or write "None this session."')

    # Notes from template.md are instructions to the writer, never content.
    for m in re.finditer(r"<[A-Za-z0-9][^<>\n]{2,}>", story):
        fails.append(f"template note left in the document, replace it: {m.group(0)[:70]}")

    # Line IDs are for the writer and for checking, not for the reader.
    ids = re.findall(r"\[?\bL\d{4}\b\]?", story)
    if ids:
        first = ", ".join(dict.fromkeys(i.strip("[]") for i in ids[:5]))
        fails.append(f"{len(ids)} line ID(s) in the document (first: {first}); remove every [Lxxxx], "
                     f"verify.py finds each quote's line on its own")

    notes = re.search(r"^##\s+Chronicler's notes\s*$", story, re.M | re.I)
    checked = story[:notes.start()] if notes else story  # the notes may quote noise on purpose
    quotes = []
    for m in re.finditer(r"“([^”]+)”|\"([^\"\n]+)\"", checked):
        q = m.group(1) or m.group(2)
        if len(tokens(q)) < 3:
            continue
        who = None
        if story[m.end():].startswith("\n"):   # block quote: attribution is on the "—" line below
            by = re.match(r"\s*>\s*—\s*([^,\[\n]+)", story[m.end():m.end() + 200])
            who = by.group(1).strip() if by else None
        quotes.append((q, who))

    ok = 0
    party = data.get("characters", [])
    sources = []   # (line ID, speaker, quote) for the report
    for q, who in quotes:
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
        # The window can start a line or two before the quote: report the line it best matches.
        pos = kept.index(at)
        run = [k for k in kept[pos:pos + 3] if lines[k]["discordId"] == lines[at]["discordId"]]
        at = max(run, key=lambda k: lcs(qt, tokens(lines[k]["text"])))
        if (lines[at]["id"], short) not in {(s[0], s[2]) for s in sources}:
            sources.append((lines[at]["id"], lines[at]["speaker"], short))
        if DESCRIBED.search(q):
            warns.append(f"quote reads like a player describing an action ({lines[at]['id']}), not speech: "
                         f"retell it as narration in the third person: “{short}”")
        # Tags are regex hints, so these warn rather than fail. Older lines.json files have no tags.
        hints = [t for t in lines[at].get("tags", []) if t in ("dmg", "mech") or t.startswith("ooc?")]
        if hints:
            warns.append(f"quote is from a line tagged {', '.join(hints)} ({lines[at]['id']}): quote only in-character "
                         f"lines with no mechanics in them: “{short}”")
        if who and lines[at]["speaker"] == "GM" and (who.lower().startswith("of ")
                                                     or any(who == c or who == c.split()[0] for c in party)):
            warns.append(f"quote is the GM narrating ({lines[at]['id']}) but is attributed to {who}: "
                         f"tell it in the story instead, or attribute it to the NPC speaking: “{short}”")

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

    unquoted = re.sub(r"“[^”]*”", lambda q: " " * len(q.group(0)), story_side)   # same offsets as story_side
    for m in layout.RECORDING_TALK.finditer(unquoted):
        fails.append(f"the story mentions the recording ('{m.group(0)}'); bridge the gap from what comes before and "
                     f"after, and put it in Chronicler's notes: {line_of(story_side, m.start())}")

    seen_standins = set()
    for m in layout.CREATURE_STANDIN.finditer(unquoted):
        word = m.group(0).lower()
        if word not in seen_standins:
            seen_standins.add(word)
            warns.append(f"'{m.group(0)}' names a creature by how it moves; keep its kind "
                         f"(\"the beholder\", \"the floating aberration\"): {line_of(story_side, m.start())}")

    # Magic is told by its effect; a spell is named only where it turns the scene. A sentence
    # that lists spell names ("under Shield, Fly, See Invisibility and Invisibility") reads as
    # a spellbook. People and places in such a list are fine ("Sparrow, Malar and Fade").
    people = {n.lower() for n in data.get("characters", [])}
    people |= {a["name"].lower() for a in data.get("actorDetails", {}).get("npcs", [])}
    people |= set(re.findall(r"^\|\s*([^|]+?)\s*\|", layout.section(story, "NPCs in Session") or "", re.M))
    people = {p.lower() for p in people} | {w for p in people for w in p.lower().split()}
    spells = {s.lower() for s in data.get("spellsUsed") or []}
    prose = re.sub(r"“[^”]*”|\"[^\"\n]*\"", " ", story_side)
    prose = "\n".join(l for l in prose.splitlines() if not l.lstrip().startswith("|"))
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", prose):
        items = [i for m in layout.TITLE_LIST.finditer(sentence)
                 for i in re.split(r",\s*(?:and\s+)?|\s+and\s+", m.group(0))
                 if i.strip() and i.strip().lower() not in people]
        named = {s for s in spells if re.search(r"\b" + re.escape(s) + r"\b", sentence.lower())}
        if len(items) >= 3 or len(named) >= 2:
            warns.append("a sentence lists spells; tell what they did and name at most one: "
                         f"{sentence.strip()[:100]}")

    def section(name):
        return layout.section(story, name)

    table = section("At the table")
    for word in sorted({w.lower() for w in PRIVATE.findall(table) for w in ([w] if isinstance(w, str) else [w[0]])}):
        warns.append(f"At the table mentions private life ('{word}'): keep only what matters to the game")

    tale = section("The story")
    paras = [p.strip() for p in re.split(r"\n\s*\n", tale) if p.strip() and not p.strip().startswith("<")]
    prose = [p for p in paras if not p.startswith("#")]
    subheads = [p.splitlines()[0] for p in paras if p.startswith("#")]
    if subheads:
        fails.append(f"The story is one continuous tale: remove its subheadings ({subheads[0][:60]}); "
                     f"carry scene changes in the prose")
    for p in prose:
        words = len(p.split())
        if words > layout.PARAGRAPH_MAX_WORDS:
            warns.append(f"The story: a {words}-word paragraph, split it by beat: {p[:60]}…")

    deeds = section("Deeds of the party")
    for c in data.get("characters", []):
        if deeds and c.split()[0] not in deeds:
            warns.append(f"player character missing from Deeds of the party: {c}")

    print(f"quotes     {ok} of {len(quotes)} verified")
    for lid, speaker, short in sources:
        print(f"  {lid} {speaker}: “{short}”")
    for w in warns:
        print(f"WARN  {w}")
    for f in fails:
        print(f"FAIL  {f}")
    print("PASS" if not fails else f"{len(fails)} problem(s): fix the story and run verify.py again")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
