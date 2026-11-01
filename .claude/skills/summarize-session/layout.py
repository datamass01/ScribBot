"""The fixed layout of a session story, shared by prepare.py (writes each session's template.md)
and verify.py (checks a story against it).

The skeleton itself lives in template.md next to this file: its "## " headings, in order, are
the fixed sections, and the "---" line splits the story side from the table side. Change the
sections there, and the limits and table columns here. Standard library only.
"""
from __future__ import annotations

import re
from pathlib import Path

TEMPLATE_PATH = Path(__file__).with_name("template.md")
TEMPLATE = TEMPLATE_PATH.read_text(encoding="utf-8")


def _headings(text: str) -> list[str]:
    return [m.group(1).strip() for m in re.finditer(r"^##\s+(.+?)\s*$", text, re.M)]


def _sections(text: str) -> tuple[list[str], list[str]]:
    rule = re.search(r"^---\s*$", text, re.M)
    if not rule:
        raise SystemExit(f"{TEMPLATE_PATH}: needs a '---' line between the story and the table sections")
    return _headings(text[:rule.start()]), _headings(text[rule.end():])


# Story side: told inside the fiction. Table side: out of character, after the --- rule.
STORY_SECTIONS, TABLE_SECTIONS = _sections(TEMPLATE)
SECTIONS = STORY_SECTIONS + TABLE_SECTIONS

# Story-side sections where a player's name is expected (the roster says who plays whom).
PLAYER_NAMES_ALLOWED = {"Characters in Session"}

SUMMARY_MAX_CHARS = 800
# Readability of "The story" (warnings only; its length follows the session).
PARAGRAPH_MAX_WORDS = 180
CHARACTER_COLUMNS = ["Character", "Class(es)", "Level", "Player"]
# Named NPCs only. Generic monsters ("a duergar taskmaster", "Black Pudding") are Foes in "Battles".
NPC_COLUMNS = ["NPC", "Race", "Class(es)", "Level", "Part in the session"]
UNKNOWN = "Unknown"
# Words that make a name a description rather than a name: roles and creature kinds. An NPC row
# made only of these (plus Foundry's races) is a monster or a nameless extra, not a named NPC.
GENERIC_NAME_WORDS = {
    "the", "a", "an", "of", "and", "old", "young", "elder", "greater", "lesser", "giant", "ancient",
    "adult", "black", "white", "red", "green", "blue", "violet", "surviving", "unknown",
    "captain", "taskmaster", "guard", "guards", "soldier", "warrior", "priest", "shaman", "bodyguard",
    "civilian", "merchant", "delegation", "clan", "chief", "warchief", "leader", "envoy", "veteran",
    "honorguard", "sorcerer", "cleric", "wizard", "rogue", "fighter", "bandit", "cultist",
    "beholder", "pudding", "puddings", "ooze", "oozes", "fungus", "fungi", "fisher", "fishers",
    "hulk", "hulks", "umber", "dragon", "elemental", "shadow", "ghost", "slug", "ant", "spider",
    "goblin", "orc", "orcs", "troll", "ogre", "wolf", "rat", "skeleton", "zombie", "undead",
    "demon", "devil", "golem", "duergar", "dwarf", "elf", "human", "cave", "frost", "earth",
}

# The NPC table in template.md must use the columns verify.py checks.
if "| " + " | ".join(NPC_COLUMNS) + " |" not in TEMPLATE:
    raise SystemExit(f"{TEMPLATE_PATH}: the NPCs in Session table must have columns {' | '.join(NPC_COLUMNS)}")

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


# The recording itself, which never belongs in the story: gaps are bridged, not announced.
RECORDING_TALK = re.compile(
    r"\b(recording|recorded|transcri(?:pt|bed|ption)s?|scribbot|the bot|"
    r"(?:lost|missing|unrecorded) (?:minutes|stretch|part)|(?:minutes|stretch) (?:of [\w ]{1,20})?(?:was|were) lost|"
    r"never (?:caught|captured)|not captured|the (?:tale|thread|record) (?:breaks|broke)(?: off)?)\b",
    re.I,
)

# A stand-in name made from how a creature moves ("the floater", "the walker", "the crawling
# thing"), which drops what kind of creature it is (PROMPT.md: a second name keeps the kind).
CREATURE_STANDIN = re.compile(
    r"\bthe (?:(?:float|fl[iy]|walk|crawl|swimm?|slither|hover|drift|creep|glid|lurk|stalk|"
    r"shambl|lumber|scuttl|skitter|burrow|climb)(?:er|ers|ing (?:thing|one|shape)s?)|flyers?)\b",
    re.I,
)

# Three or more Title Case names in a comma/"and" list: "Shield, Fly, See Invisibility and
# Invisibility". verify.py drops people from the items before counting them as spells.
_TITLE = r"[A-Z][\w'/-]*(?:\s+(?:of|from|to|the|[A-Z][\w'/-]*))*"
TITLE_LIST = re.compile(rf"\b{_TITLE}(?:,\s*{_TITLE})+,?\s+and\s+{_TITLE}")


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


def template(byline: str, characters: list[dict]) -> str:
    """template.md with this session's byline, Foundry roster and Deeds rows filled in. Headings
    and order are fixed; everything in <angle brackets> is for the writer to replace."""
    deeds = [f"- **{c['character']}:** <1–3 notable deeds this session>" for c in characters]
    fill = {
        "{{BYLINE}}": byline,
        "{{SUMMARY_MAX_CHARS}}": str(SUMMARY_MAX_CHARS),
        "{{CHARACTER_TABLE}}": "\n".join(character_table(characters)),
        "{{DEEDS}}": "\n".join(deeds) or "- **<Character>:** <1–3 notable deeds this session>",
    }
    out = TEMPLATE
    for token, value in fill.items():
        out = out.replace(token, value)
    left = re.findall(r"\{\{[A-Z_]+\}\}", out)
    if left:
        raise SystemExit(f"{TEMPLATE_PATH}: unknown placeholder(s) {', '.join(sorted(set(left)))}")
    return out


def headings(story: str) -> list[str]:
    """Level-2 headings in the order they appear."""
    return _headings(story)


def section(story: str, name: str) -> str:
    m = re.search(rf"^##\s+{re.escape(name)}\s*$(.*?)(?=^##\s|^---\s*$|\Z)", story, re.M | re.S | re.I)
    return m.group(1) if m else ""
