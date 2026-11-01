"""The fixed layout of a session story, shared by prepare.py (writes template.md) and verify.py
(checks a story against it). Change the section order or limits here and nowhere else.
Standard library only.
"""
from __future__ import annotations

import re

# Story side: told inside the fiction, always in this order.
STORY_SECTIONS = [
    "High level summary",
    "Characters in Session",
    "NPCs in Session",
    "Objectives Completed",
    "The story",
    "Major events",
    "Battles",
    "Iconic items and loot",
    "Memorable quotes",
    "Deeds of the party",
    "Loose threads",
]
# Table side: out of character, after a --- rule, always in this order.
TABLE_SECTIONS = ["At the table", "Action items", "Chronicler's notes"]
SECTIONS = STORY_SECTIONS + TABLE_SECTIONS

# Story-side sections where a player's name is expected (the roster says who plays whom).
PLAYER_NAMES_ALLOWED = {"Characters in Session"}

SUMMARY_MAX_CHARS = 800
CHARACTER_COLUMNS = ["Character", "Class(es)", "Level", "Player"]
UNKNOWN = "Unknown"

# Words that read as engineering or software rather than storytelling. Allowed when the
# campaign is science fiction (prepare.py --style sci-fi).
JARGON = re.compile(
    r"\b(mechanics?|mechanically|data|output|process(ed|ing)?|optimi[sz](e|ed|ing|ation)|"
    r"deploy(ed|ing|s)?|parameters?|"
    r"metrics?|algorithm|interface|module|config(ured|uration)?|bandwidth|throughput|"
    r"debuff(ed|s)?|buff(ed|s)?|aggro|dps|tank(ed|ing)?|nerf(ed)?|cooldown|proc(ced|s)?|"
    r"stats?|bonus(es)?|modifier|action economy|turn order|round \d+|initiative|hit points?|"
    r"utili[sz](e|ed|ing)|leverag(e|ed|ing)|implement(ed|ing)?|functionality|efficient(ly)?)\b",
    re.I,
)


def class_text(classes: list[dict]) -> str:
    """'Rogue 5 / Shadowdancer 4' from Foundry's class list; Unknown when there is none."""
    parts = [f"{c['name']} {c['level']}" if c.get("level") is not None else c["name"] for c in classes or []]
    return " / ".join(parts) or UNKNOWN


def character_table(rows: list[dict]) -> list[str]:
    """rows: {character, classes, level, player}. Markdown table lines for "Characters in Session"."""
    out = ["| " + " | ".join(CHARACTER_COLUMNS) + " |", "|" + "---|" * len(CHARACTER_COLUMNS)]
    for r in rows:
        level = str(r["level"]) if r.get("level") is not None else UNKNOWN
        out.append(f"| {r['character']} | {class_text(r.get('classes', []))} | {level} | {r['player']} |")
    return out


def template(title_hint: str, byline: str, characters: list[dict]) -> str:
    """The skeleton a writer fills in. Headings, order and the character roster are fixed;
    everything in <angle brackets> is to be replaced."""
    s = [
        f"# <{title_hint}>",
        "",
        f"*{byline}*",
        "",
        "## High level summary",
        "",
        f"<One paragraph, at most {SUMMARY_MAX_CHARS} characters: the tale of the session in brief.>",
        "",
        "## Characters in Session",
        "",
        *character_table(characters),
        "",
        "## NPCs in Session",
        "",
        "- **<NPC>:** <who they are and the part they played this session>",
        "",
        "## Objectives Completed",
        "",
        "- <a goal the party achieved this session> [Lxxxx]",
        "",
        "<Or \"None this session.\">",
        "",
        "## The story",
        "",
        "<4-8 paragraphs of high-fantasy narrative with 3-6 inline quotes, each with its [Lxxxx].>",
        "",
        "## Major events",
        "",
        "- **[HH:MM:SS]** <turning point> [Lxxxx]",
        "",
        "## Battles",
        "",
        "### <Name of the fight>",
        "- **Foes:** … · **Where:** …",
        "- **Big moments:** <told as legend, no numbers> [Lxxxx]",
        "- **Outcome:** …",
        "",
        "## Iconic items and loot",
        "",
        "- **<Item>** <what it is or does> → <who bears it, or \"unclaimed\"> [Lxxxx]",
        "",
        "## Memorable quotes",
        "",
        "> “<verbatim quote>”",
        "> — <Character or NPC>, [HH:MM:SS] [Lxxxx]",
        "",
        "## Deeds of the party",
        "",
        *[f"- **{c['character']}:** <1-3 deeds this session>" for c in characters],
        "",
        "## Loose threads",
        "",
        "- <open question, oath, plan or cliffhanger>",
        "",
        "---",
        "",
        "## At the table",
        "",
        "- <rulings, table agreements, tech problems, absences; players by player name> [Lxxxx]",
        "",
        "## Action items",
        "",
        "- [ ] **<GM | Player name | Everyone>:** <what to do> [Lxxxx]",
        "",
        "## Chronicler's notes",
        "",
        "- <gaps, interruptions, unsure names, lines set aside>",
        "",
    ]
    return "\n".join(s)


def headings(story: str) -> list[str]:
    """Level-2 headings in the order they appear."""
    return [m.group(1).strip() for m in re.finditer(r"^##\s+(.+?)\s*$", story, re.M)]


def section(story: str, name: str) -> str:
    m = re.search(rf"^##\s+{re.escape(name)}\s*$(.*?)(?=^##\s|^---\s*$|\Z)", story, re.M | re.S | re.I)
    return m.group(1) if m else ""
