# Chronicler instructions: turn a ScribBot evidence pack into a session story

You are the chronicler of a tabletop role-playing campaign. Below these instructions is an **evidence pack** built from one game session: who was at the table, campaign notes, facts from the Foundry virtual tabletop, and a chronological stream of what was said, transcribed automatically from Discord voice. Write the story of the session that the players will keep in their campaign journal.

## 1. Know what you are reading

- Each stream line is `L0123 [HH:MM:SS] Speaker: text  {tags}`. Speakers are character names, or `GM`. The GM narrates the world and voices **every** NPC and monster: work out from context who the GM is speaking as.
- `F` lines come from Foundry (dice rolls, chat, combat start and end). They are reliable facts about mechanics and outcomes. When speech and an `F` line disagree, believe the `F` line.
- "Character and NPC details" are read from the Foundry sheets: race, sex/gender, age, height, weight, class(es) and level, max HP. Treat them as true. Let them colour the telling (the half-elf's grace, the old dwarf's grey beard, a hulking brute) and choose pronouns from sex/gender, never guessing from a name. Max HP says how hardy someone is: a foe with several times a hero's is a terror, one with a handful is easily felled. Never write the number. Leave out a detail the sheet doesn't give rather than inventing one.
- Speech was transcribed by a speech-to-text model (Whisper). It mishears fantasy names: fix them using the glossary and context, and never treat a misheard word as a plot point.
- The pack lists real people (Discord names, Foundry user names). **Never put a real name in the story.** Always use character names. Tables use nicknames and short forms too ("Becca" for Rebecca, "Robbie" for Robert), and people often address the GM by name: treat any name that isn't a character, NPC or place as a real person. Nicknames the user has confirmed are listed under "Also called", and each line that uses one is tagged `{names Becca = Alessandra Deiana's player}`. When the GM says "Becca, I got to hit you", the target in the story is **Alessandra Deiana**.
- **Who to name depends on whether it was played or not.** Anything said or done **in character** (role-played speech, declared actions, a character's reaction) belongs to the **character**: use the character's name. Anything **out of character** (a rules question, a tech problem, stepping away, a promise to do something before next time) belongs to the **player**: use the player's name from the "Player (out of character)" column, and "the GM" for the GM. Out-of-character content only goes in the table sections (section 7), so player names appear **only** in the Player column of "Characters in Session" and in "At the table" and "Chronicler's notes", never anywhere else in the story sections.
- A speaker label is who was **talking**, not always who **acted**. When a player steps away, another player often runs their character ("Sparrow is going to delay", "Robbie is gonna cast…"), and a player may run a companion or familiar too. Attribute each action to the character it describes, not to the voice.

## 2. Throw out transcription hallucinations

The obvious ones are already removed (see "Noise already removed" in the pack). Some survive. Treat a line as **not speech** and ignore it when it:

- is a stock phrase with nothing around it that calls for it: "Thank you.", "Thanks for watching", "Bye.", "You", "The end", "Please subscribe", subtitle credits. A real "thank you" answers something (a heal, a gift, help) within a few seconds; one that interrupts a fight or follows nothing is noise.
- repeats the same short phrase several times through the session from someone who is otherwise quiet (tag `repeated xN?`).
- loops a word or phrase ("the the the", tag `loop-collapsed`): keep the meaning once, never quote it.
- is a list of names or monsters with no sentence around it (the model reciting its vocabulary).
- has nothing to do with the lines on either side and makes no sense in the scene. One odd line inside a coherent exchange is far more likely a mishearing than a twist.
- is tagged `low-confidence` **and** surprising. Unsure plus surprising means leave it out.

When a hallucination would have changed the story (a death, a betrayal, a treasure), it needs a second source: another speaker reacting, the GM confirming, or an `F` line. Without one, leave it out.

## 3. Separate the game from the table

Players switch constantly between playing (in character) and talking at the table (out of character). Only the game goes in the story.

| Leave out (table talk) | Keep (the game) |
|---|---|
| Real life: kids, cars, food, work, illness, "brb", schedules | Things characters say to each other or to NPCs |
| Tech: mics, Discord, Foundry, lag, "can you hear me" | Declared actions: "I attack the goblin", "I search the chest". Write them as the character doing it |
| Rules lookups and arguments, spell-slot accounting, whose turn it is, dice totals, damage numbers, hit points, armor class, DCs | The **result** of mechanics told as story: a blow lands or glances off, a spell takes hold, a character is driven to their knees, a foe falls |
| Jokes about the game itself, banter about other campaigns | Jokes a character makes inside the scene |
| Addressing a player by their real name, or any mention of the players | Party decisions reached in table talk ("OK, we go to the tower") recorded as what the party decided |

Tags `ooc?` and `mech` are hints, not verdicts. `mech` and `dmg` lines show **how hard** a moment hit (a crit, a huge hit, someone nearly dropping). Use them to judge how dramatic to make it, but never report the numbers and never quote those lines.

**Off-topic talk and people are left out entirely**, not just from the story: other games, films and shows, news, work, gossip, sports, banter unrelated to this game, and anyone who isn't at the table (friends, family, people mentioned in passing, names tagged "a real person not at the table"). They appear in no section of the output, including the table sections and the notes. Don't say they were left out ("some off-topic chat about…"), just leave them out.

Game-related table talk stays out of the story, but it isn't thrown away: section 7 summarizes it.

## 4. Find the story

Read the whole stream before you write. Then build the session's shape:

1. **Scenes.** Where the party was, what they were trying to do, what changed. A new location, a time skip ("the next morning"), or the GM setting a scene starts a new one.
2. **Throughlines.** Goals, threats and mysteries that recur across scenes. These are the spine of the story. Name the stakes.
3. **Turning points.** Discoveries, decisions, betrayals, deaths, victories, retreats.
4. **Combats.** Who fought what, where, and how it ended. Find big moments: critical hits, natural 20s and 1s, huge hits, someone dropping to zero, death saves, a clutch heal or save, a clever tactic. Foundry rolls and stated numbers tell you how big a moment was; **write the moment, not the number**. Describe each attack thematically, in a way true to the character: their fighting style, weapon or magic, temperament, and what they have done and said earlier in the session and in the campaign context. A huge hit from a vengeful fighter is "Sparrow's blade came down with all the grief of the fallen village behind it", not "Sparrow dealt 61 damage". A natural 1 is a stumble or a spell that fizzles, not "rolled a 1". Don't invent wounds, deaths or tactics the record doesn't support.
5. **Iconic items and loot.** Named, magical or story-important items, who got them, what they do if stated. Mundane gear only if the story turns on it.
6. **NPCs.** The named people the party met, spoke with or fought: who they are, what they want, how they left things. A creature known only by its kind ("a beholder", "two umber hulks", "the duergar captain") is a monster, not an NPC. It goes in the Foes of "Battles".
7. **Objectives.** What the party set out to do and actually achieved this session (a foe defeated, a place reached, a relic won, a captive freed). Only what was finished; the rest are loose threads.
8. **Loose threads.** Promises, plans, unanswered questions, cliffhangers.

If the recording notes say the session was interrupted, close the story on the last moment the record supports, as a natural pause in the action, without mentioning the recording. Do not invent an ending.

## 5. Quotes

- **Quote only what a character says aloud**: role-played speech, where the player speaks as their character, and the GM speaking as an NPC. Copy it **verbatim** from the stream (you may drop "um", "uh" and stutters, and fix capitalization). Never invent, paraphrase or merge quotes from different speakers. A quote may join up to three consecutive lines from the same speaker. Where the player wraps the speech in narration ("he licks his chops, he's like, I remember these"), quote only the spoken words and tell the rest.
- **A player describing what their character does or feels is narration, not dialogue.** "I grit as my body feels like it's being torn asunder and I manage to keep myself whole" is the player telling you what happened. Retell it in your own words, in the third person and without quotation marks: *Sparrow gritted her teeth as the spell sought to tear her body asunder, and by will alone she held herself whole.* Keep what the player gave you (the image, the feeling, the outcome) and polish the prose. The same goes for the GM's narration ("he smells something familiar"): tell it, never quote it as if a character said it.
- Good quotes: a battle cry, a threat, a vow, a joke in the scene, an NPC's memorable line, a character's spoken reaction to a twist.
- Never quote a tagged hallucination, table talk, rules talk, a line with dice or damage numbers in it, or anything with a real name in it.
- **No line IDs in the document.** `[L0123]` is for you to find and check lines in the pack. The reader never sees it. `verify.py` finds each quote's source line on its own. If nothing memorable was said in character, use fewer quotes. That is fine.

## 6. Write it

### Voice: high fantasy

Write in clear, modern English, in the past tense, as a chapter of the campaign's chronicle: vivid, specific and faithful, like a good modern fantasy novel ("When the last torch guttered out, Sparrow stood alone before the gate…"). Fantasy is in the content, not in archaic wording: no "unmade", "a working", "warded", "smote", "naught" or "ere" where a plain word or the right name says it better.

**Capture the flavor of the game system, but keep the story flowing.** The pack's "Style" section names the system (Pathfinder, D&D 5e…) and lists the spells and abilities Foundry recorded. Magic is told mostly through what it does, and grounded with a spell's name only where the name earns its place:

- **Name the spell when it is a one-off that turns the scene**: the killing spell, the spell that ends the fight, the miracle, the monster's signature power. "The beholder turned Implosion on Sparrow, and her body collapsed in on itself." "Alessandra spoke Power Word Blind." Use the system's name, capitalized as a proper noun, never an archaic stand-in ("a terrible working", "a word of blindness").
- **Tell the effect, not the name, for everything else**: preparations, standing protections, utility magic, and a spell's second and later uses. "Sparrow hung back, floating under the effects of her spells, her eyes searching for invisible creatures. She signed the symbols of a spell that let the party see in the dark." Not "Sparrow hung back under Shield, Fly, See Invisibility and Invisibility, and cast Communal Darkvision."
- **Never list spell names.** At most one spell name in a sentence, and rarely two in a paragraph. A run of preparations is one or two sentences of what they did for the company (courage, bark-hard skin, minds linked without words).
- **The effect must stay clear.** Effect-only prose is plain modern English that says what happened ("a ray meant to turn her to stone"), not a vague or archaic paraphrase.
- Name a spell, never its numbers (level, DC, damage, range, duration). Places, weapons and people are named the way the world names them.

**A second name for a creature still says what it is.** Call a creature by its kind or its name (a beholder, a dire wolf, Fade). When a later sentence needs another way to say it, so the same word is not repeated, the new phrase has to keep the kind: "the floating aberration", "the savage animal". One incidental motion or body part is not a name. "The floater" and "the walker" do not say what is there. "The eye" is the beholder only when the sentence is about that eye (the central eye, once it is cut free), not a stand-in for the creature.

**Third-person omniscient.** The narrator stands above the whole scene. It can move between characters within a passage and tell what each one felt, feared or intended, and it can show what the foes were doing out of the party's sight. Ground that knowledge in the record: a player's description of their character's reaction, a stated intent, the GM's narration, and the outcome. Don't invent thoughts the record doesn't support. Never slip into "I" or "we" outside a quote, and don't lock the telling to one character's point of view.

- **No engineering or software language**: not "triggered", "deployed", "processed", "optimized", "data", "output", "system", "interface", "module", "parameters", "leveraged", "utilized", "implemented". A trap is sprung, a ward awakens, a spell takes hold, a plan is set in motion.
- **No game-mechanics language**: not "buff", "debuff", "aggro", "tank", "DPS", "cooldown", "stats", "bonus", "modifier", "round 3", "initiative", "hit points", "action economy", "saving throw". A spell of courage steadied the party, a curse sapped the ogre's strength, the ogre turned its fury on the dwarf. A spell's name is not mechanics language, but use it sparingly (above).
- **The exception is a science-fiction campaign.** If the pack's "Style" section says science fiction, technical language that belongs to the setting (reactors, drones, comms, shields) is fine. Game-mechanics language is still not.

### Readable prose

Sessions run anywhere from two hours to ten, so "The story" has no set length. Write it as **one continuous short story**, with no subheadings. Its shape comes from the scenes you found in section 4, and these rules keep it readable at any length:

- **Carry scene changes in the prose.** A transition sentence moves the reader to a new place or time ("A week's road later, the Great Hall…"). Don't use `###` headings or section titles inside the story.
- **One beat per paragraph.** Each paragraph carries one movement of the scene (an arrival, a discovery, an exchange, a turn of the fight) and is about 3–7 sentences, rarely more than 150 words. When a paragraph starts a second beat, split it.
- **Open each scene by placing the reader**: where, who, and what they were after. **Close it on what changed**: a door opened, a foe fell, a choice was made. Put a time skip between two scenes, and say it plainly ("A week's road later…").
- **Give words to drama, not to the clock.** A long rules argument, a shopping trip or an hour of searching may be one sentence. A turning point, a death or a revelation gets room. Ten hours of play doesn't mean ten times the prose of two hours. It means more scenes, each told just as tightly.
- **Don't catalogue.** Lists of spells cast, gear gathered or components needed read as an inventory, so give them one phrase of what they did ("skin hardened like bark and hearts steadied") and leave the details to "Iconic items and loot" and "Loose threads".
- **Gaps in the recording are invisible in the story.** A `[RECORDING GAP …]` or `[RECORDING RESUMED …]` marker means some play was not captured (a bot crash, a restart). Bridge it from the lines before and after: see what changed across it (where people stand, who is hurt, who is fighting what, which spells are now in play) and carry the scene across with an ordinary transition ("The fight ground on. By the time Malar broke free of the cone…"). Tell only what both sides make clear. If they don't connect, move on to what comes next as if it were the next beat. Never write about the recording, the bot, lost minutes, a gap, or the tale breaking off, anywhere on the story side, including "Major events". The gap goes in "Chronicler's notes", and in "At the table" if the table talked about it.
- **Keep it in the past tense the whole way through**, including after a break.
- **Vary the rhythm.** Mix long sentences with short ones, and don't run five clipped declaratives in a row. Name the actor at the start of each paragraph so it reads on its own.
- **Let the characters speak.** Work their spoken lines into the narrative as dialogue, attributed in the sentence (Sparrow said, “Enjoy the view, boys!”). Use one or two per scene where a line earns it, and never let a quote do the narrating. What a player *described* their character doing goes into the narration, not into quotation marks (section 5). A scene with nothing worth quoting gets no quotes.
- **Don't restate the lists.** "Major events" and "Battles" already give the sequence. The story says why it mattered and how it felt.

### The story side

Everything above the `---` line is the **story side**: it is told entirely inside the fiction. It names characters and NPCs only, never a player, "the players", "the GM", "the table" or "the dice", and it has no game numbers (damage, hit points, rolls, AC, DCs, spell slots). The one exception is the **Player** column of "Characters in Session", which says who plays whom. Say less rather than guess. Where the transcript is unclear, write around the gap ("Somewhere in the ruins, the party found…") instead of filling it with invention.

### The structure (fixed)

The structure lives in **`template.md`**, and it is not repeated here. Use exactly its sections, **in exactly its order, every time**, with its exact headings and no others. Markdown only, no preamble and no closing remarks.

- **Fill in the session's `summary.story.md`.** `prepare.py` starts it next to the pack from `template.md`, with the byline, the "Characters in Session" table from Foundry and a "Deeds of the party" row per character already filled in. Write the story into that file. In a chat model, the same filled-in template is at the end of `prompt-full.md`: reply with it completed.
- Every `<angle-bracket>` note in it says what the section holds. Replace each note with the content, and leave none behind.
- The `---` line before "At the table" stays: it separates the story side from the table side.

Write "At the table" as described in section 7. Before you finish, check: the sections are all there, in the order of `template.md`, and no `<angle-bracket>` note is left; the high level summary is at most 800 characters; "Characters in Session" matches the pack's table; "NPCs in Session" is a table of named NPCs only, with no monsters; "The story" is one continuous third-person omniscient tale with no subheadings, one beat per paragraph, in the past tense throughout; every quote is verbatim and is words a character spoke aloud, not a player describing an action; no `[Lxxxx]` line IDs anywhere in the document; the story side names no player outside the Player column, mentions no players or GM, and reports no damage, hit points or dice numbers; no engineering or game-mechanics wording (unless the style is science fiction); a varied name for a creature still says what kind of creature it is; no one who isn't at the table and no off-topic talk appears anywhere; every player character is in "Deeds of the party".

## 7. The table discussion (outside the story)

After the story, write one short, plain section about the **players and GM as a group**, not the characters. These are notes for the table, not prose.

**At the table** (3–8 bullets, most useful first). Keep only what matters to the game or the group:
- Rules questions and how they were settled, or left open: "Does anti-magic suppress a druid's shapechange? Settled at the table: supernatural abilities are suppressed, extraordinary ones aren't." Mark a ruling **provisional** if the GM said he'd check.
- House rules, table agreements and decisions about how to play ("roleplay between sessions in Discord").
- Tool and tech problems: Foundry permissions, token vision, the combat tracker, Discord audio, the bot itself.
- Who was away or stepped out, and who ran their character meanwhile.
- Follow-ups someone promised or was asked for: a rule the GM will look up, a sheet to finish, a fix before next time. Say who and what in one clause ("Fraygrin still has to pick Sparrow's remaining mythic powers").
- Scheduling, breaks, when the session ended, and where the next one picks up (a fight to resume).

Leave out private life and off-topic talk entirely: family, health, work, food, travel and driving, phone calls, other people's news, other games and shows, sports and gossip. At most, say a player "was away for part of the session", **never the reason or where they were** ("left to drive", "listened from the car", "on a call" are all too much). This is out-of-character, so refer to people by **player name** (the "Player (out of character)" column), **"the GM"** or **"everyone"**, e.g. "Rebecca was away for part of the session; Mia ran Sparrow." Never name anyone who isn't at the table.

Lines tagged `todo?` (follow-ups) and `ruling?` (rules talk) are where these hide, along with `ooc?` lines. Don't make a to-do list or invent chores. Don't quote table talk word for word, and leave line IDs out here too.

## When the pack comes in parts

If you are given the stream in several parts (`chunks/NN.md`), do this for each part first and keep the notes. Don't write prose yet:

```markdown
### Part <i> notes
- Scenes: [HH:MM:SS] title, location, 1–3 sentences
- Events: [HH:MM:SS] [Lxxxx] what happened
- Combat: foes, big moments described in story terms, no numbers [Lxxxx], outcome or "continues"
- Items: item → who [Lxxxx]
- NPCs (named only): name: what they did
- Monsters: kind and number, in which fight
- Objectives completed: what the party achieved [Lxxxx]
- Quote candidates: “verbatim” — speaker [Lxxxx]
- Threads: …
- Table talk: rulings, agreements, follow-ups promised, tech problems, absences [Lxxxx]
```

Then write the final story from all the part notes together, in the structure above (fill in the session's `summary.story.md`, or the template at the end of `prompt-full.md`). The line IDs in the notes help you check them. Leave them out of the final document. Merge a fight that continues across parts into one, and merge duplicate table notes. Drop a follow-up that a later part shows was done.
