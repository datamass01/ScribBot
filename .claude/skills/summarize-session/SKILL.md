---
name: summarize-session
description: Write a high-fantasy, story-style summary of a recorded ScribBot game session in a fixed section order (high level summary, characters with class/level/player, named NPCs in a table, objectives completed, the story, battles told without damage numbers, quotes, items) plus a brief summary of the table discussion (rulings, agreements, follow-ups) for the players and GM, from its transcript, Foundry chat log and timeline, after removing Whisper hallucinations ("Thank you", "Thanks for watching", caption credits, decoder loops) and table talk. Use when asked to summarize, recap, chronicle or write up a session, to "tell the story" of session N, to note what was agreed or promised at the table, to clean a transcript of hallucinations, or to check a written summary's quotes. Works with any LLM.
---

# Summarize a ScribBot session as a story

Two stdlib Python scripts do the parts a model is bad at, and one prompt does the part a model is good at. The skill's **`template.md`** is the story skeleton: its headings, in order, are the fixed sections, and each `<note>` says what goes there. A shared `layout.py` reads it and holds the 800-character summary limit and the table columns, so every story comes out in the same shape. Any LLM can be the writer: you, another agent, or a chat model the user pastes into.

1. `prepare.py` reads the session's outputs and writes an **evidence pack**. It drops Whisper hallucinations with a stated reason for each, tags table-talk, damage and item hints, merges Foundry rolls and combats, and numbers every line (`L0123`).
2. The model follows **`PROMPT.md`** on the pack and fills in `summary.story.md`, which `prepare.py` starts from `template.md`. The sections always come in this order: **High level summary** (≤ 800 characters), **Characters in Session** (Character | Class(es) | Level | Player, pre-filled from Foundry), **NPCs in Session** (NPC | Race | Class(es) | Level | Part in the session, named NPCs only; monsters are Foes in Battles), **Objectives Completed**, The story, Major events, Battles, Iconic items and loot, Memorable quotes, Deeds of the party, Loose threads. Then, kept apart from the story, **At the table** (rulings, table agreements, follow-ups someone promised, tech problems, absences, with no private life) and **Chronicler's notes**. The rules that shape it:
   - **High fantasy voice, in modern English.** Vivid but not archaic, with no engineering, software or game-mechanics wording ("triggered", "deployed", "buffed", "aggro"). `--style sci-fi` allows technical language for a science-fiction campaign.
   - **The game system's own names.** `prepare.py` puts the Foundry game system (sent with the chat log by module 0.5.0+, else inferred from the chat log's `systems/<id>/` and compendium links) and every spell and ability card Foundry posted into the pack's "Style" section. Magic is told mostly by its effect, for the story's flow. A spell is named, by its system name as a proper noun, only where it is a one-off that turns the scene (Implosion, Power Word Blind). Preparations and utility spells are told by what they did ("her eyes searching for invisible creatures"), spell names are never listed, and archaic stand-ins ("a folding spell") and spell numbers stay out.
   - **A varied creature name keeps the kind.** Say "the floating aberration" or "the savage animal", not "the floater" or "the walker". The full rule is in `PROMPT.md`.
   - **A short story, not a length limit.** "The story" is one continuous tale with no subheadings, as long as the session needs, from two hours to ten. It is told third-person omniscient, in the past tense, one beat per paragraph, with scene changes carried in the prose (PROMPT.md, "Readable prose").
   - **Dialogue vs. described action.** Words a character speaks aloud are quoted as dialogue (Sparrow said, “Enjoy the view, boys!”). What a player *describes* their character doing or feeling ("I grit as my body…") is retold as narration, never quoted.
   - **No line IDs in the document.** `[L0123]` is for the writer to find lines in the pack. `verify.py` finds each quote's source on its own and prints it.
   - **No damage numbers.** Fights are told thematically, true to each character and what they've done in the session, never "dealt 61 damage" or "rolled a 20".
   - **Off-topic talk and people are left out of every section**: other games, news, gossip, and anyone not at the table.
   - **In character → character name; out of character → player name.** Role-played speech and actions belong to the character. Rules talk, tech problems, absences and to-dos belong to the player, named by the pack's "Player (out of character)" column (the GM is "the GM").
   - **The story side never mentions the players.** Player names, "the players" and "the GM" appear only in the Player column of "Characters in Session" and in "At the table" and "Chronicler's notes".
3. `verify.py` checks the result. Every section must be present exactly once and in order, the high level summary must fit in 800 characters, the character table must match Foundry, the NPC table must have the right columns, list no player character and match any Foundry sheet, objectives can't be empty, quotes must be verbatim and must not come from dropped lines, the document may contain no line IDs, "The story" may have no subheadings, and a fantasy story fails on engineering or game-mechanics words outside quotes. The story side may contain no real names and no damage, hit-point or dice numbers. Names of people not at the table fail anywhere. Mentions of players or the GM on the story side, private life in "At the table", and an NPC row named only by creature kind or role ("Duergar Taskmaster") get a warning. Fix and re-run until it prints `PASS`.

Paths below are relative to the repo root. The skill lives in `.claude/skills/summarize-session/`.

## Run it (agent path)

```sh
python .claude/skills/summarize-session/prepare.py 12
```

`12` is the session number. A folder id (`2026-11-01-6ae0bcc6`) or `latest` (the newest finished session with a transcript) also works.

### Step 1: confirm nicknames with the user (exit code 2)

Players call each other by nicknames that aren't in Discord or Foundry ("Becca" for Rebecca, "Robbie" for Robert), and they mention people who aren't at the table ("told by Morgan"). If such names are left unknown, a real person can end up in the story, and "Becca, I got to hit you" can't be tied to Alessandra. So `prepare.py` finds these names, suggests who each one is, and **stops with exit code 2 without writing the pack**. It prints each name with its evidence lines, the reason for its suggestion, and a ready `--nickname` command. The same details are saved to `story/nicknames.md`.

**Ask the user. Never confirm a name yourself, even when the suggestion looks obvious.** A wrong guess puts a real person in the story or credits an action to the wrong character. In Claude Code, use AskUserQuestion, with one question per name and four names per call. Show the evidence line in the question, and use these options:
1. the suggested character, marked "(Recommended)";
2. the next most likely character;
3. "A real person not at the table";
4. "Not a person" (a companion, NPC, place or misheard word).

Other agents ask the same in plain text. Then re-run with the answers:

```sh
python .claude/skills/summarize-session/prepare.py 12 --nickname "Becca=Alessandra Deiana" --nickname "Robbie=Sparrow" --nickname "Sira=Ruyn Musaffir" --nickname "Morgan=absent" --nickname "Fade=not-a-person" --nickname "Iowa=not-a-person" --nickname "Lady=absent"
```

- WHO is a character (it maps to that character's **player**), `GM`, `absent` (a real person not at the table) or `not-a-person`. Player and Discord names also work.
- Answers are saved in `data/nicknames.json` (git-ignored, because it holds real names) and keyed to the player's Discord ID, so each name is asked about **once per campaign**, not once per session. To change an answer, pass `--nickname` again.
- A human running `prepare.py` in a real terminal is asked each question directly instead (press Enter to accept the suggestion).
- `--unconfirmed-ok` writes the pack anyway and treats every unconfirmed name as a real person. Use it only when the user says to skip the questions.

Confirmed names show up in the pack's "People at the table" table ("Also called"), and every line that uses one is tagged with whose it is, e.g. `{names Becca = Alessandra Deiana's player}`. `verify.py` then fails a story section that contains any of them, and fails any section that names an `absent` person.

### Step 2: write and verify the story

Output goes to `data/sessions/<id>/story/` (git-ignored):

| File | Use |
|---|---|
| `pack.md` | The whole session for the model, about 12k tokens for 55 minutes |
| `chunks/NN.md` | The same stream in self-contained parts, for small-context models |
| `noise.md` | Every dropped line and why. Rescue a line only if the story needs it |
| `summary.story.md` | The story to write: the skill's `template.md` with the byline, the Foundry character table and the Deeds rows filled in. Created only when it doesn't exist, so re-running `prepare.py` never overwrites a story. To start over, rename or delete it and re-run |
| `lines.json` | Input for `verify.py` (also holds the Foundry sheet details used, under `actorDetails`) |
| `prompt-full.md` | `PROMPT.md`, `pack.md` and the filled-in template in one file, to paste into any chat model |

Then write the story:

1. Read `.claude/skills/summarize-session/PROMPT.md` and `data/sessions/<id>/story/pack.md` in full.
2. Fill in every section of `data/sessions/<id>/story/summary.story.md`, replacing each `<note>`. Keep the headings and their order exactly as they are.
3. Verify it:

```sh
python .claude/skills/summarize-session/verify.py data/sessions/2026-11-01-6ae0bcc6/story/summary.story.md
```

The command exits 0 with `PASS`. It lists the source line of every verified quote, so a reviewer can check them against the pack. Each `FAIL` names what to fix. `WARN` lines (a quote that reads like a described action, a quote from a mechanics line, an overlong paragraph) are worth fixing but don't fail the run.

**Interrupted game recorded as two sessions** (bot crash, then a new `/scrib start`): pass both, e.g. `prepare.py 12 13` once #13 has stopped (tested on #10 and #11). They're stitched in time order into one story. It inserts a `[RECORDING RESUMED …]` marker (a session already joined with `/scrib merge` gets a `[RECORDING GAP …]` marker from its merge line) and de-duplicates the chat logs, which overlap. The story bridges the gap from what comes before and after and never mentions it; the gap is noted only in "Chronicler's notes" and "At the table".

## Other LLMs

- **Big context (≥ 32k tokens):** give the model `prompt-full.md` as the message. Save its reply as `summary.story.md` and run `verify.py`.
- **Small context (8k):** run `prepare.py … --chunk-minutes 15`, which makes parts of about 3k tokens. Send `PROMPT.md` plus one `chunks/NN.md` at a time and ask for the "Part notes" format at the end of `PROMPT.md`. Then send all the part notes with the filled-in template from the end of `prompt-full.md` and ask for the final story.
- Pasting into a hosted model sends the transcript to that provider. Get the table's consent, as the README requires for `/scrib summarize`. A local model (Ollama at `OPENAI_BASE_URL`) keeps it on the machine.
- This doesn't replace the bot's `/scrib summarize` (which writes `summary.json` and imports it into Foundry). The story is a separate file.

## Import into Foundry

Once `verify.py` passes, `/scrib story session:<N>` in Discord (or **Import ScribBot Session** → "story" in Foundry's journal directory) imports `summary.story.md` as a journal entry, one page per section. The bot refuses a story that still has `<template notes>`. A stitched story is found from either session. An image on a line of its own (`![alt](banner.png)`, the file next to the story) becomes a banner (before the first section) or an inline picture; the bridge client copies it into Foundry, which needs the **Upload New Files** permission. Images elsewhere in a line, or pointing at URLs, are dropped. Re-importing replaces the entry's pages.

## What the hallucination filter does

Measured on session #12 (720 lines): 80 lines dropped as hallucinations and 16 as filler, with no real speech lost in review. It drops:

| Rule | Example from real sessions |
|---|---|
| Video-subtitle boilerplate anywhere in a line | "Thanks for watching!", "Closed Captioning provided by the Amara.org community", "I'll see you in the next video", "This is a work of fiction…" |
| Silence phrase on a short clip that nothing just said invites | "Thank you." on a 0.4 s clip. Kept and tagged `thanks-real?` when the clip is ≥ 2 s, confident (probability ≥ 0.8), or follows "here", "take", "heal"… |
| Capitalised fragment ending in a comma | "Gryffindor,", "Kylo Ren,", "Xenoblade," |
| A line that is only a repeated phrase | "Giant Slug Giant Slug Giant Slug" (the old hotword echo) |
| Too many words for the clip, plus listing or repeating | "Giant Scorpion, Giant Shark, Giant Sparrow…" (15 words in 0.7 s) |
| Another script when the language is English | "K нажми и нажми на колокольчик!" |
| Filler and laughter | "Um", "Mm-hmm", "Ha, ha, ha" |

It **trims rather than drops** when real speech carries an outro ("…a drop off, and Alif, as always, thanks for watching" keeps the narration and is tagged `boilerplate-trimmed`). It **tags** (the model decides) `noise?`, `timing?`, `repeated xN?`, `low-confidence`, `ooc?:names a player`, `ooc?:real world`, `ooc?:mic check`, `mech`, `dmg`, `item?`, `todo?` (a follow-up, fix, promise or scheduling, which feeds "At the table") and `ruling?` (a rules question or ruling, which feeds "At the table").

## Character and NPC details from Foundry

The ScribBot Foundry module sends, with every roster sync, each character and NPC actor's name, race, sex/gender, age, height, weight, class(es) and levels, and max HP (`foundry-module/scripts/actors.js`; PF1, dnd5e and pf2e sheets, racial hit dice left out, PF1 mythic tiers labelled, a dnd5e NPC with no race gets its creature type). The bot saves them in `data/foundry-actors.json` and, for the session, in `data/sessions/<id>/actors.json`:

- at `/scrib start` it copies the last sync there;
- Foundry re-syncs when it hears the session start and again at `/scrib stop`, and every sync while recording replaces the session's copy;
- the roster also re-syncs when the bridge connects, when an actor is created, deleted, renamed or its details or max HP change, and when a class or race item is added, changed or removed. Max HP that the system works out from other values (PF1 adds Constitution) is only picked up at the session start and stop syncs.

`prepare.py` reads the session's copy (the latest session's when several are combined; the world-wide file when the session has none) and puts in the pack:

- "Characters in Session": class and level per character, copied into the template;
- "Character and NPC details": a table for the party and one for every NPC actor named in the session's speech or chat (by full name, or by a non-title word of it: "Vell" for "Mayor Vell"; at most 40). The writer uses them for descriptions and pronouns and never writes max HP.

If `prepare.py` warns `no class/level from Foundry for …`, or the details table says nothing has been synced, the world is still running an older module: update it, reload Foundry so the GM's client reconnects, then re-run `prepare.py`. Until then the template says "Unknown". Sessions recorded before the update have no `actors.json` and use the world-wide file, which shows the sheets as they are now.

## Gotchas

- **`prepare.py` refuses a session that's recording** (it checks `data/scribbot.db` before touching any file, so it never opens a live `timeline.json`). Summarize after `/scrib stop`.
- **A crashed session has no end time and no chat log.** The chat log uploads only on `/scrib stop`. The pack says so under "Recording notes". The story closes on the last moment the record supports, as a natural pause, without mentioning the recording. How hard a blow landed then has to be judged from what the GM said aloud.
- **Sessions not yet finalized** (no `transcript.json`) are read from `transcript.partial.jsonl`. That's better for hallucination detection, because it keeps Whisper's word probability, which `transcript.json` drops.
- **The speaker isn't always the actor.** On #12, Sparrow's player left and Alessandra's player ran Sparrow ("Robert is gonna step out…", "Robbie is gonna cast…") and her companion Fade. `PROMPT.md` tells the model to attribute actions to the character described.
- **`campaign/context.md` and `glossary.md` are still the template examples** (Thorin, Elara, Grubnak). They appear in the pack but don't describe this campaign. Fill them in and the story's names get better.
- **Old sessions** recorded before `/scrib map` have no characters in `timeline.json`. `prepare.py` fills them from the `mappings` table, the same source the bot resolves from.
- **Line IDs are stable** across re-runs of `prepare.py` on the same sessions: they're numbered before filtering. A story keeps verifying after the filter rules are tuned. Stitching a different set of sessions renumbers them.
- **Windows console:** both scripts force UTF-8 output. Without that, curly quotes print as `�`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `FAIL sections out of order` / `unexpected section` | Restore the headings from the skill's `template.md`. The headings and their order are fixed in the skill's `template.md`; change them there, not in a story |
| `FAIL High level summary is N characters` | Cut it to 800 or fewer, spaces included. Detail belongs in "The story" |
| `FAIL engineering or game-mechanics wording` | Retell it in the world's words ("the ward awoke", not "the trap triggered"). For a sci-fi campaign, run `prepare.py … --style sci-fi` |
| `FAIL Characters in Session: … Foundry says …` | Copy the row from the pack's "Characters in Session" table. If Foundry is wrong, fix the sheet, let it re-sync, and re-run `prepare.py` |
| `FAIL quote matches a line dropped as noise` | The quote is a hallucination (often "Thank you for watching"). Remove it, or rescue the line from `noise.md` only if it is clearly real |
| `FAIL quote …` for words you quoted in "Chronicler's notes" | That section is exempt from quote checks; check the heading is exactly `## Chronicler's notes` |
| `Session 13 (…) is still recording` | Expected. Wait for `/scrib stop` |
| `… has no transcript yet. Run /scrib process first.` | No `transcript.json` and no `transcript.partial.jsonl`: the clips were never transcribed |
| `FAIL game numbers in the story sections` | Rewrite the moment without the number ("the bolt tore through its wing", not "18 damage"). Quotes with numbers in them don't belong in the story either |
| `FAIL N line ID(s) in the document` | Delete every `[Lxxxx]`. Quotes are checked without them |
| `FAIL The story is one continuous tale: remove its subheadings` | Drop the `###` lines and carry the scene change in a transition sentence |
| `FAIL NPCs in Session needs a table` | Use the table from the skill's `template.md`: NPC, Race, Class(es), Level, Part in the session. Write "None this session." if no named NPC appeared |
| `WARN NPCs in Session: '…' reads as a kind of creature or a role` | It's a monster or a nameless extra. Delete the row and make sure it's in the Foes of its fight in "Battles" |
| `FAIL NPCs in Session: … Foundry says …` | Copy Race, Class(es) and Level from the pack's NPC details table |
| `WARN quote reads like a player describing an action` | Take the quotation marks off and retell it as narration: “I grit as my body…” becomes "Sparrow gritted her teeth…" |
| `FAIL the story mentions the recording` | Remove it. Carry the scene across the gap from what happened before and after ("The fight ground on…"), and note the gap in "Chronicler's notes" |
| `WARN '<the floater>' names a creature by how it moves` | Use its kind or name, or a variant that keeps the kind ("the beholder", "the floating aberration"). Reported once per stand-in word |
| `WARN a sentence lists spells` | Tell what the spells did ("floating under the effects of her spells, her eyes searching for invisible creatures") and name at most one, the one that matters |
| `WARN The story: a N-word paragraph` | It holds more than one beat. Split it where the action turns |
| `FAIL real name in the story sections` for a player | That line is out of character: move it to "At the table", or write it as the character |
| A real name is in the story but `verify.py` passes | `prepare.py` didn't spot the nickname. Re-run it with `--nickname "<Nick>=<character or absent>"`, then run `verify.py` again. A one-off check also works: `verify.py … --real-name <Nick>` |
