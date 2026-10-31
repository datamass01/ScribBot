# ScribBot

ScribBot records your tabletop RPG sessions on Discord, transcribes them locally with [Cactus Whistle](https://huggingface.co/Cactus-Compute/whistle), maps every voice to its FoundryVTT character, has an LLM (Claude, Grok, or any OpenAI-compatible model) write an adventure summary, and imports that summary back into Foundry as a journal entry.

```
Discord voice ──► bot/ (Node)  ── one WAV per speech burst per speaker + timeline.json
                    │ HTTP+WS :7420
                    ├──► worker/ (Python, Cactus Whistle on the CPU) ──► transcript.json / .md
                    ├──► summarizer (Claude / Grok / OpenAI-compatible) ──► summary.json / .md
                    └◄─► foundry-module/ (GM's browser): roster in, chat+combat log in, journal out
```

Discord sends each person's audio as a separate stream, so ScribBot always knows exactly who is speaking. No speaker diarization is needed.

## What you get per session (`data/sessions/<id>/`)

| File | Contents |
|---|---|
| `timeline.json` | Who spoke when, plus the clip files (deleted once transcribed, by default) |
| `transcript.md` / `.json` | `[00:12:31] Thorin (Alice): Stand aside or taste my axe!` |
| `chatlog.json` | Foundry chat, dice rolls and combats during the session |
| `summary.md` / `.json` | Title, recap, scenes, combats, verified quotes, character highlights, NPCs, loot, open threads |

Quotes are checked against the transcript. Any quote the model cannot match to words someone actually said is dropped (and listed in `droppedQuotes`).

## Setup

### 1. Discord application
1. Go to <https://discord.com/developers/applications>, create **New Application** → **Bot**, and copy the token.
2. Invite the bot from OAuth2 → URL Generator: scopes `bot` and `applications.commands`; permissions **View Channels**, **Send Messages**, **Attach Files**, **Embed Links**, **Connect**. (It joins muted, so it doesn't need **Speak**.)
3. No privileged intents are needed.

### 2. Configure
```sh
cp .env.example .env    # then fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, API_TOKEN, and an LLM key
```
Set `DISCORD_GUILD_ID` to your server's ID so slash commands appear instantly.

### 3. Transcription worker (Python 3.10+, no GPU needed)
```sh
cd worker
py -3.13 -m venv .venv
.venv\Scripts\pip install -e .
.venv\Scripts\python -m scribworker.check    # loads Whistle (downloads the 17 MB weights on first use)
.venv\Scripts\python -m scribworker          # serves on 127.0.0.1:7421
```
[Whistle](https://huggingface.co/Cactus-Compute/whistle) is Cactus Compute's 17 MB speech-to-text model (Apache-2.0), run through the `cactus-needle` package. It runs on the CPU and handles English, German, French, Spanish, Italian, Dutch and Polish; set `STT_LANGUAGE`, or leave it blank to auto-detect. Names from your glossary and Foundry actors are passed to it as keywords so it spells them correctly. The bot records at 16 kHz, Whistle's native rate.

### 4. Bot (Node 22.12+)
```sh
cd bot
npm install
npm run register     # registers /scrib with Discord (once, and after command changes)
npm start
```

### 5. Foundry module (v12/v13)
1. Copy or symlink `foundry-module/` into `{FoundryData}/Data/modules/scribbot-bridge`, then enable **ScribBot Bridge** in your world.
2. As GM, open module settings and set **ScribBot URL** (`http://localhost:7420`) and **API token** (`API_TOKEN` from `.env`). Both are stored only in your browser.
3. Add your Foundry URL to `FOUNDRY_ORIGINS` in `.env` (e.g. `http://localhost:30000`, or `https://yourgame.forge-vtt.com`).
4. Optional: open **Link Discord accounts** in the module settings and paste each player's Discord user ID. Players are then mapped automatically. Otherwise use `/scrib map`.

The module talks to the bot from the GM's browser. Browsers treat `http://localhost` as secure, so this works even when Foundry is served over HTTPS (Forge, etc.), **as long as the bot runs on the GM's own computer**. If it runs elsewhere, put it behind HTTPS (a reverse proxy or a tunnel such as Cloudflare Tunnel or Tailscale Funnel) and use that URL.

## Monitoring dashboard

While the bot is running, open <http://localhost:7420/> and enter your `API_TOKEN` (it is kept only in that browser; `http://localhost:7420/#token=...` also works as a bookmark). The page refreshes every 3 seconds and shows:

- **Warnings**: worker down, missing LLM credentials, unmapped speakers, no Foundry module connected while recording, failed sessions, low disk, default API token
- **Live recording**: elapsed time, clip count, and each speaker with their character, highlighted while they talk
- **Components**: Discord gateway, transcription worker (queue, live clips), summarizer config, Foundry module (connection, last roster sync and chat log upload), host (uptime, memory, disk)
- **Sessions**: status with transcription progress, clips, speakers, and which files exist (transcript, chat log, summary), plus any error
- **Activity**: the bot's recent log output and pipeline events, filterable

The same data is available as JSON from `GET /status` and `GET /logs?after=<seq>` (both need the token). API keys are never included.

## Running a session

| Command | What it does |
|---|---|
| `/scrib start` | Joins your voice channel, posts a recording notice, and lists who is mapped to which character |
| `/scrib stop` | Stops recording. The Foundry module uploads the chat/combat log, then transcription and summarization run, and the summary is posted in Discord and imported into Foundry |
| `/scrib map @user <character>` | Autocompletes from Foundry users/characters, or type any name |
| `/scrib gm @user` | Marks the GM: their speech is treated as narration and NPC voices |
| `/scrib mappings`, `/scrib status`, `/scrib sessions` | Info |
| `/scrib process [session] [retranscribe]` | Resume after a failure, or redo everything |
| `/scrib summarize [session]` | Rewrite only the summary (e.g. after editing `campaign/context.md`) |

**Tell your players they are being recorded.** ScribBot posts a notice on `/scrib start`, but get consent from your group first. Audio never leaves your machine. The transcript text is sent to the LLM provider you configure.

### Live transcription and audio deletion
By default (`DELETE_AUDIO_AFTER_TRANSCRIBE=true`) each clip is transcribed while you play, about a second after the speaker pauses. Its WAV is deleted as soon as the text is safely written to disk. Only the timeline and transcript are kept, and the transcript is ready almost immediately at `/scrib stop`. If the worker is down during play, clips wait on disk and are transcribed at stop, so nothing is lost. The trade-off is that a session can't be re-transcribed later (for example, after adding names to the glossary). Re-running the *summary* still works.

Set `DELETE_AUDIO_AFTER_TRANSCRIBE=false` to keep audio. It is then deleted `AUDIO_RETENTION_DAYS` after the session is summarized.

### Campaign context
- `campaign/glossary.md`: names of characters, NPCs and places. These are fed to Whistle as keywords so it spells them right, and to the summarizer to fix mis-hearings. Foundry actor names are added automatically.
- `campaign/context.md`: setting, party, and the story so far. Sent with every summary.

### Without Discord / Foundry
```sh
cd bot
npx tsx scripts/transcribe-dir.ts ../data/sessions/<id>      # transcribe a session folder (keeps audio unless --delete-audio)
npm run summarize -- <session-id|latest> [--retranscribe]     # transcribe (if needed) + summarize
```
In Foundry, journal directory → **Import ScribBot Session**, or from a macro:
`game.modules.get("scribbot-bridge").api.importSummary("latest")`.

## LLM providers
| `LLM_PROVIDER` | Default model | Key |
|---|---|---|
| `anthropic` | `claude-opus-5-5` | `ANTHROPIC_API_KEY` (or `ant auth login`) |
| `xai` | `grok-4` | `XAI_API_KEY` |
| `openai-compatible` | set `LLM_MODEL` | `OPENAI_BASE_URL` + `OPENAI_API_KEY` (OpenAI, Ollama, LM Studio, OpenRouter) |

Long sessions are summarized in two passes. Each ~25-minute chunk (`SUMMARY_CHUNK_MINUTES`) is turned into structured notes, separating in-character from out-of-character speech. The notes are then merged into the final summary. Output is schema-constrained JSON (see `shared/schemas/`).

## Development
```sh
cd bot && npm test && npm run typecheck      # vitest (also tests foundry-module/scripts/journal.js)
cd worker && .venv\Scripts\python -m pytest
cd bot && npm run schemas                    # regenerate shared/schemas from the zod definitions
```
