# ScribBot

ScribBot records your tabletop RPG sessions on Discord, transcribes them locally with [Cactus Whistle](https://huggingface.co/Cactus-Compute/whistle), maps every voice to its FoundryVTT character, has an LLM (Claude, Grok, any OpenAI-compatible model, or the Codex, Antigravity, Claude Code or Grok CLI) write an adventure summary, and imports that summary back into Foundry as a journal entry.

```
Discord voice ──► bot/ (Node)  ── one WAV per speech burst per speaker + timeline.json
                    │ HTTP+WS :7420
                    ├──► worker/ (Python, Cactus Whistle on the CPU) ──► transcript.json / .md
                    ├──► summarizer (Claude / Grok / OpenAI-compatible / Codex / Antigravity / Claude Code / Grok CLI) ──► summary.json / .md
                    └◄─► foundry-module/ (bridge user's browser): roster in, chat+combat log in, journal out
```

Discord sends each person's audio as a separate stream, so ScribBot always knows exactly who is speaking. No speaker diarization is needed.

## What you get per session (`data/campaigns/<world>/sessions/<session id>/`)

Sessions are filed by Foundry world (the campaign; rename it in the Console without touching the folder) and by the id of the session's first recording, e.g. `2026-11-01-6ae0bcc6`, so folders sort by the date play started. The session number lives only in the database (the Console and Discord show it), so renumbering never moves a folder. Folders from older versions named `012` are renamed by **Update folder layout** in the Console or `npm run migrate-layout -- --apply`.

| File | Contents |
|---|---|
| `transcript.md` / `.json` | `[00:12:31] Thorin (Alice): Stand aside or taste my axe!` The Markdown is self-contained (what it is, how it was transcribed, who plays whom), so you can hand it to any LLM yourself |
| `chatlog.json` | Foundry chat, dice rolls and combats during the session |
| `summary.md` / `.json` | Title, recap, scenes, combats, verified quotes, character highlights, NPCs, loot, open threads |
| `story/` | The story write-up, if you made one (below) |
| `recordings/<id>/` | Each Discord recording's raw material: who spoke when, the clips (deleted once transcribed, by default) and its own transcript. A game split by a restart and merged has two |

Sessions recorded before this layout are in `data/sessions/<id>/`. Move them with the Console (**Sessions → Update folder layout**) or `cd bot && npm run migrate-layout` (a dry run; add `-- --apply` with the bot stopped). Everything is backed up to `data/backups/` first.

Quotes are checked against the transcript. Any quote the model cannot match to words someone actually said is dropped (and listed in `droppedQuotes`).

## Setup

**Quick install.** One script sets up steps 3 and 4 (the worker's venv and the bot's packages) and creates `.env` from the template if you don't have one. It's safe to run again.
```sh
.\install.ps1          # Windows (PowerShell 5.1 or 7)
./install.sh           # macOS / Linux
```
It starts with a checklist of what passed and what's missing. You install the prerequisites yourself: **Node.js 22.12+**, **Python 3.10+** (with `venv`; on Debian/Ubuntu that's the separate `python3-venv` package) and **build tools** (Linux: `make`; macOS: the Xcode Command Line Tools; Windows: the Visual Studio C++ build tools). The bot's SQLite package ships prebuilt binaries, but npm still runs `node-gyp` for it, and `node-gyp` needs those tools. For anything missing, the installer prints the command for your system (winget, Homebrew, apt, dnf, pacman, zypper) and waits while you install it, then checks again. It then lists what it will set up, asks before installing, and asks separately about the optional downloads (the speech model, faster-whisper when `.env` says `STT_ENGINE=whisper`, and a browser when `FOUNDRY_HEADLESS` is on).

Options: `-Yes` / `--yes` (don't ask, take the defaults; also the behavior when input isn't a terminal), `-Preflight` / `--preflight` (only print the checklist; exit 1 if a prerequisite is missing), `-Whisper` / `--whisper` (faster-whisper for `STT_ENGINE=whisper`), `-Cuda` / `--cuda` (the same, with the NVIDIA libraries), `-Dev` / `--dev` (test dependencies), `-Check` / `--check` (load the speech model once), `-Chromium` / `--chromium` (Playwright's Chromium for the Foundry bridge). Then do steps 1–2 and start it (below). On macOS/Linux every `.ps1` script has a `.sh` twin (`start.sh`, `start-worker.sh`, `start-console.sh`) with the same options spelled `--register`, `--no-restart`, `--check`, `--no-browser`, `--port <n>`, `--no-log-file`; in the manual steps, use `.venv/bin/python` in place of `.venv\Scripts\python`.

### 1. Discord application
1. Go to <https://discord.com/developers/applications>, create **New Application** → **Bot**, and copy the token.
2. Invite the bot from OAuth2 → URL Generator: scopes `bot` and `applications.commands`; permissions **View Channels**, **Send Messages**, **Attach Files**, **Embed Links**, **Connect**. (It joins muted, so it doesn't need **Speak**.)
3. No privileged intents are needed.

### 2. Configure
```sh
cp .env.example .env    # then fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, API_TOKEN, and an LLM key
```
Set `DISCORD_GUILD_ID` to your server's ID so slash commands appear instantly.

Or let the Console do it: run `.\start-console.ps1` (any Python 3.10+, nothing to install), open **Configuration**, and use **Create .env from the template**. The setup checklist there says what's still missing and how to fix it.

### 3. Transcription worker (Python 3.10+, no GPU needed; optional NVIDIA GPU for Whisper)
```sh
cd worker
py -3.13 -m venv .venv
.venv\Scripts\pip install -e .
.venv\Scripts\python -m scribworker.check    # loads Whistle (downloads the 17 MB weights on first use)
.venv\Scripts\python -m scribworker          # serves on 127.0.0.1:7421
```
[Whistle](https://huggingface.co/Cactus-Compute/whistle) is Cactus Compute's 17 MB speech-to-text model (Apache-2.0), run through the `cactus-needle` package. It runs on the CPU and handles English, German, French, Spanish, Italian, Dutch and Polish; set `STT_LANGUAGE`, or leave it blank to auto-detect. Names from your glossary and Foundry actors are passed to it as keywords so it spells them correctly. The bot records at 16 kHz, Whistle's native rate.

**Better accuracy: Whisper large-v3.** Set `STT_ENGINE=whisper` to transcribe with OpenAI's Whisper large-v3 (through `faster-whisper`), which is far more accurate than Whistle on conversational speech and still runs entirely on your machine. Install it once in `worker\`:
```powershell
.venv\Scripts\pip install -e ".[whisper,cuda]"   # NVIDIA GPU (WHISPER_DEVICE=cuda, the default)
.venv\Scripts\pip install -e ".[whisper]"        # CPU only (WHISPER_DEVICE=cpu)
.venv\Scripts\python -m scribworker.check        # loads the model (downloads about 3 GB the first time)
```
`WHISPER_DEVICE` picks `cuda` or `cpu`; precision defaults to float16 on CUDA and int8 on CPU (`WHISPER_COMPUTE_TYPE` overrides it). On an RTX GPU a clip transcribes several times faster than real time; on a CPU, large-v3 runs at roughly real time, so a busy table may build a queue that catches up after `/scrib stop`. Glossary names are passed to Whisper as hotwords. The worker loads the model at startup and `/status` warns if that fails (for example, `cuda` without an NVIDIA GPU). Switching engines takes a worker restart.

**Short clips.** Most clips are one or two seconds long. With Whisper, each clip is first checked for speech on the CPU (Silero VAD, `WHISPER_VAD`). Clips without speech never reach the model. On near-silence, Whisper used to loop for up to a minute per clip and write things like "Thanks for watching!" or the hotword list. At most `WHISPER_MAX_HOTWORDS` (30) hotwords are sent, and none for clips under `WHISPER_HOTWORDS_MIN_SECONDS` (1.5 s). Decoding retries are bounded. On real session clips this went from about 2.5 to about 300 clips per minute, with identical text on real speech.

**Pause, resume and restarts.** Hold transcription (the current clip finishes), for example while a game needs the GPU:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:7421/pause  -ContentType application/json -Body '{"reason":"boss fight"}'
Invoke-RestMethod -Method Post http://127.0.0.1:7421/resume -ContentType application/json -Body '{}'
```

Restarting the worker is safe for recorded audio. When it starts, it re-queues every clip from the last `WORKER_RECOVER_HOURS` (12) that has audio but no text yet. A transcription the bot is waiting for at `/scrib stop` or `/scrib process` rides out the restart: the bot retries for up to 5 minutes and resubmits the job, which reuses every clip already done. The dashboard shows the paused state, the worker's per-clip timing and what was re-queued.

The worker runs everything on one thread, highest priority first: live clips, then the end-of-session job of a session that was just live (and clips re-queued after a restart), then everything else, such as `/scrib process` on an old session. After `WORKER_RELOAD_AFTER_FAILURES` (5) model errors in a row, for example a CUDA fault, it reloads the model; if that fails it exits so `start-worker.ps1` restarts it. A clip that runs longer than `WORKER_SLOW_CLIP_SECONDS` (60) is logged with its path. With Whisper, a clip that is only a stock silence phrase ("thank you", "you", "bye"…), shorter than `WHISPER_FILLER_MAX_SECONDS` (2) and decoded with low confidence (`WHISPER_FILLER_MAX_PROBABILITY`, 0.7) is dropped; `/health` counts these as `fillerDropped`. The worker logs to `data/logs/worker-YYYY-MM-DD.log` as well as its window.

### 4. Bot (Node 22.12+)
```sh
cd bot
npm install
npm run register     # registers /scrib with Discord (once, and after command changes)
npm start
```

Once steps 1–4 are done, `.\start.ps1` at the repo root starts both: the worker in its own window (waiting until `/health` answers), then the bot. Add `-Register` to re-register the slash commands first. To run only the worker in the current window (to watch its log), use `.\start-worker.ps1` (`-Check` loads Whistle once first). If PowerShell blocks scripts, run `powershell -ExecutionPolicy Bypass -File .\start.ps1`. On macOS/Linux, `./start.sh` does the same in one terminal: the worker runs in the background with its lines prefixed `[worker]`, and Ctrl+C (or SIGTERM) stops both; `./start-worker.sh` runs the worker alone. In Windows PowerShell 5.1, chain commands with `;` rather than `&&` (for example `cd bot; npm run register`).

Both scripts **supervise** what they start: if the bot or worker exits with an error (a crash), it is restarted after 5 seconds, up to 5 times in 10 minutes. Ctrl+C (a clean exit) stops it for good; `-NoRestart` turns the restarts off. For a service that survives logging off, wrap the same commands in NSSM, WinSW or a Task Scheduler task with restart-on-failure.

### 5. Foundry module (v12/v13)
1. In Foundry's setup screen, go to **Add-on Modules → Install Module** and paste this **Manifest URL**, then enable **ScribBot Bridge** in your world:
   `https://raw.githubusercontent.com/datamass01/ScribBot/main/foundry-module/module.json`
   (For development, copy or symlink `foundry-module/` into `{FoundryData}/Data/modules/scribbot-bridge` instead.)
   To publish a module update: bump `version` in `foundry-module/module.json`, run `.\package-foundry-module.ps1` to rebuild `releases/scribbot-bridge.zip`, and commit both to `main`.
2. Pick the **bridge user**, whose browser talks to the bot. By default that's the active GM. If a player runs the bot instead, the GM sets **Bridge user** in the module settings to that player.
3. As the bridge user, open module settings and set **ScribBot URL** (`http://localhost:7420`) and **API token** (`API_TOKEN` from `.env`). Both are stored only in that browser.
4. Add your Foundry URL to `FOUNDRY_ORIGINS` in `.env` (e.g. `http://localhost:30000`, or `https://yourgame.forge-vtt.com`).
5. Link Discord accounts: run `/scrib map @player` and pick the player's Foundry user from the list. The bot then writes that Discord ID into Foundry for you (the module's **Discord ID** on that user), as soon as a GM is online; mappings made while Foundry was closed are filled in on the next roster sync. `/scrib map` wins if the two disagree, and `/scrib unmap` clears the link it wrote. With exactly one GM user in the world, `/scrib gm` links that user too. A mapping typed as a free-text name has no Foundry user, so it can't be written. You can still set IDs by hand under **Link Discord accounts** in the module settings.

The module talks to the bot from the bridge user's browser. Browsers treat `http://localhost` as secure, so this works even when Foundry is served over HTTPS (Forge, etc.), **as long as the bot runs on the bridge user's own computer**. If it runs elsewhere, put it behind HTTPS (a reverse proxy or a tunnel such as Cloudflare Tunnel or Tailscale Funnel) and use that URL.

**Let ScribBot join Foundry by itself (optional).** Instead of keeping someone's browser open, the bot can log in to the world as its own player in a headless browser:
1. In Foundry, create a player user named `ScribBot` with a password. As GM, set the module's **Bridge user** to `ScribBot` (module 0.4.0+).
2. In `.env`, set `FOUNDRY_HEADLESS=session` (join while recording, leave once the chat log is uploaded) or `always` (stay joined), plus `FOUNDRY_PASSWORD`. `FOUNDRY_URL` defaults to the first `FOUNDRY_ORIGINS` entry; `FOUNDRY_USER` defaults to `ScribBot`. ScribBot says in Foundry's chat when it joins and why ("ScribBot joined to record session 12.") and before it leaves; set `FOUNDRY_ANNOUNCE=false` to keep it quiet. Those messages are left out of the chat log used for summaries.
3. Check it with `cd bot && npm run foundry` (needs the bot running for the module's connection check). It joins, prints what it sees, and logs out. On Windows it drives the installed Edge; elsewhere set `FOUNDRY_BROWSER=chrome`, or run `npx playwright-core install chromium` in `bot/`.

The bot sets the module's URL and token in its own browser, waits for the chat log before summarizing, and joins briefly to import a summary if it isn't connected when the summary is ready. The player-bridge rules below apply to it. The dashboard's Foundry card shows its state, and `/status` explains a failed join.

**When the bridge user is a player:**
- The GM's client still creates the journal entries. The player's browser fetches each summary and hands it to the active GM's client over Foundry's socket, and the GM needs module version 0.2.0 or later.
- If no GM is online, the summary is imported once one connects. If the player has Foundry's **Create Journal Entries** permission, it's created right away instead, at the top level if they can't create folders.
- The chat log only includes messages everyone could see. Whispers and blind rolls are left out.
- The combat log is still recorded by the GM's client, so a GM should be online during play.

**Character and NPC details.** With each roster sync the module sends every character and NPC actor's race, sex/gender, age, height, weight, class(es) and levels, and max HP, read from PF1, dnd5e or pf2e sheets. The bot keeps the latest in `data/foundry-actors.json`, and a copy with each recording (`recordings/<id>/actors.json`, and the session's `actors.json`): it seeds the copy at `/scrib start`, and Foundry re-syncs on session start, on sheet changes during play and at `/scrib stop`. The story skill uses that copy for the character table, descriptions and pronouns.

## The Console

`.\start-console.ps1` (macOS/Linux: `./start-console.sh`) opens the ScribBot Console at <http://127.0.0.1:7422/> (`CONSOLE_PORT`): one local page to set up and run ScribBot from your desktop. It doesn't replace anything: every `/scrib` command, the Foundry module's dialogs and the bot's own dashboard keep working, and closing the Console (or the browser) stops nothing. The bot and the worker never depend on it.

| Tab | What it does |
|---|---|
| **Sessions** (default) | Start a recording in a voice channel (the recording notice is still posted in the text channel you pick), stop it, resume a failed session, re-transcribe, summarize, merge a continuation, post the summary or story to the Foundry journal (the Foundry column shows ✓ with the entry's name once ScribBot Bridge 0.7.0+ confirms it exists, or "sent" until then), give a session a title and notes, preview its transcript and summary, and move it to the trash (a dialog says how long it will be kept, with a "Don't show this again" box; `TRASH_CONFIRM` brings it back; restore it, or delete it permanently; the trash empties itself after `TRASH_RETENTION_DAYS`, default 14, set under Configuration → Storage and retention). While a session is in the trash, the next new session is numbered after the highest session that isn't; if a restored session then shares its number with a newer one, the later of the two by start time moves up one (e.g. two 16s: the newer becomes 17), and the sessions after it shift up to make room. Also the **Players and characters** table (`/scrib map`, `unmap`, `gm`) |
| **Monitoring** | The dashboard below, plus pause, resume and restart buttons for the worker. It works while the bot is down too: then it shows a crash notice if the bot went down mid-recording, the worker's queue, whether it's safe to shut down, and the bot's last log lines |
| **Configuration** | A setup checklist, and a form for `.env` with labels, help, validation and the processes each setting needs restarted. Secrets are write-only: the page only learns whether one is set. Under **Summaries**, **Summaries via** chooses **API** or **CLI (signed-in account)** first; the Provider list and the fields below it (API key and base URL, or CLI path) then show only that kind. It isn't stored: it follows from `LLM_PROVIDER`. **Which models?** under Model lists the ids the selected provider accepts: asked from the CLI itself (`codex debug models`, `agy models`, `grok models`; cached 10 minutes, **Refresh** asks again), or a built-in list for Claude Code (aliases such as `opus`, `sonnet`, `fable`, and full ids) and the API providers. Click an id to put it in Model. The box also reminds you that the provider's support site may list more or different models. The speed-tuned transcription settings sit under **Advanced**, each with its tuned default and **Reset to default**, and a value known to slow transcription (turning VAD off, a long hotword list) asks before saving. Saves keep your comments and write `.env.bak`. `.env`, `.env.tmp` and `.env.bak` are written readable by your account only (mode 0600 on macOS/Linux; on Windows an ACL for your user and SYSTEM, inheritance removed), so run the bot, worker and Console as the same user. An older `.env` is tightened on the next save. The **Summaries** settings (provider, model, API keys, CLI path, chunk length, summarize automatically) are marked *live*: the bot re-reads them from `.env` for the next summary or **Test summaries**, so they need no restart. After saving anything else, **Restart bot** / **Restart worker** apply the change (refused while recording; they rely on `start.ps1` / `start-worker.ps1`, which start the process again on exit code 75). Also an editor for `campaign/glossary.md` and `context.md` |

Every action goes to the bot's `/admin` API, which runs the same code as the slash command, with the same checks. While the bot is down, sessions are listed read-only from the database. The Console reads `API_TOKEN` from `.env` itself, so the token never reaches the browser; it listens on `127.0.0.1` only, refuses other host names, and accepts changes only from its own page. Every change is written to its log, `data/logs/scribbot-YYYY-MM-DD.log`, which also gets a copy of the bot's log (`MONITOR_LOG_DIR`, kept 14 days), so the lines before a crash survive it.

It uses only the Python standard library, so it runs before the worker is installed. Flags: `-NoBrowser`, `-Port <n>`, `-NoLogFile`. `.\start-monitor.ps1` still works and starts the Console.

## Monitoring dashboard

While the bot is running, open <http://localhost:7420/> and enter your `API_TOKEN` (it is kept only in that browser; `http://localhost:7420/#token=...` also works as a bookmark). This is the one page to watch. It refreshes every 3 seconds and shows:

- **Warnings**: worker down, LLM setup that would make summaries fail (an empty `LLM_MODEL` always; missing credentials when `AUTO_SUMMARIZE` is on), unmapped speakers, a lost voice connection, no Foundry module connected while recording, failed sessions (with the `/scrib process session:N` to run), low disk, default API token
- **Transcription pipeline** (below)
- **Live recording**: elapsed time, clip count, the voice connection state (live, rejoining, lost), and each speaker with their character, highlighted while they talk
- **Components**: Discord gateway, transcription worker (queue, live clips), summarizer config, Foundry module (connection, how many of the latest session's speakers are mapped to a character or the GM by any route, how many Foundry users have a Discord ID set, last roster sync and chat log upload), host (uptime, memory, disk)
- **Sessions**: status with transcription progress, clips, speakers, and which files exist (transcript, chat log, summary), plus any error
- **Activity**: the bot's recent log output and pipeline events, filterable

The same data is available as JSON from `GET /status` and `GET /logs?after=<seq>` (both need the token). API keys are never included.

The **Transcription pipeline** panel:

- **Shutdown indicator**: green **Safe to shut down** when nothing is recording, transcribing or summarizing and the worker queue is empty. Amber **Wait** says what is still running and roughly how long it will take. Red means a recording is live, so run `/scrib stop` first.
- **Queue**: the worker's queue depth, clips not yet converted, the conversion rate per minute, whether the queue is growing or shrinking, the time to catch up, and how long since the worker last finished a clip.
- **Conversion status**: for each active session, clips converted to text out of clips recorded, with a progress bar.
- **Quality**: per session, the share of converted clips that gave nothing usable (dropped as noise) and that look like hallucinations (stock phrases such as "thank you for watching", or text made only of names from the hotword list). Hover to see the most repeated texts.
- **Alerts**: the worker has queued work but hasn't converted anything for 2 minutes; a recording has had no new audio for 3 minutes; transcription is falling behind during a recording; live clips failed; a failed session the worker is still converting from disk; many hallucinations in a session.

The pipeline never opens `timeline.json` while the bot is recording into it; it uses the recorder's own clip count.

### Logs
The bot writes `data/logs/bot-YYYY-MM-DD.log` and the worker `data/logs/worker-YYYY-MM-DD.log`, kept `LOG_RETENTION_DAYS` (14) days, so the lines before a crash survive it. The bot's file ends with its exit code and reason.

## Running a session

| Command | What it does |
|---|---|
| `/scrib start` | Joins your voice channel, posts a recording notice, and lists who is mapped to which character |
| `/scrib stop` | Stops recording. The Foundry module uploads the chat/combat log and the transcript is finished and saved as `transcript.md` in the session's folder. By default that's where it stops: nothing is sent to an LLM. With `AUTO_SUMMARIZE=true`, a summary is also written, posted in Discord and imported into Foundry |
| `/scrib map @user <character>` | Autocompletes from Foundry users/characters, or type any name. Picking a Foundry user also writes the Discord ID into Foundry |
| `/scrib gm @user` | Marks the GM: their speech is treated as narration and NPC voices |
| `/scrib mappings`, `/scrib status`, `/scrib sessions` | Info |
| `/scrib process [session] [retranscribe]` | Resume after a failure, or redo everything. With no session it picks the latest failed one, else the latest that isn't recording |
| `/scrib summarize [session]` | Send the session's transcript to the configured LLM and write the summary (or rewrite it, e.g. after editing `campaign/context.md`). The only way a transcript reaches an LLM unless `AUTO_SUMMARIZE=true`. Refuses up front if the LLM setup would fail (e.g. an empty `LLM_MODEL`) |
| `/scrib story [session]` | Import the session's story write-up (from the `summarize-session` skill) into Foundry as a journal entry. Default: the latest session with a story |
| `/scrib merge a:<N> b:<M>` | Fold session M (the continuation after a crash or restart) into session N, so the game gets one transcript and one summary. Needs Manage Server. Then run `/scrib summarize session:N` |

Each of these is also on the Console's **Sessions** tab.

**Tell your players they are being recorded.** ScribBot posts a notice on `/scrib start`, but get consent from your group first. Audio never leaves your machine. The transcript text is sent to the LLM provider you configure only when a summary is written: on `/scrib summarize`, or after every session if `AUTO_SUMMARIZE=true`. The notice's wording is in `bot/src/notice.ts`. It adds a sentence naming the online service only when sessions are summarized automatically by one (not with `AUTO_SUMMARIZE=false`, or with a local summarizer: `openai-compatible` at a loopback or private-network address, e.g. Ollama).

### Live transcription and audio deletion
By default (`DELETE_AUDIO_AFTER_TRANSCRIBE=true`) each clip is transcribed while you play, about a second after the speaker pauses. Its WAV is deleted as soon as the text is safely written to disk. Only the timeline and transcript are kept, and the transcript is ready almost immediately at `/scrib stop`. If the worker is down during play, clips wait on disk and are transcribed at stop, so nothing is lost. The trade-off is that a session can't be re-transcribed later (for example, after adding names to the glossary). Re-running the *summary* still works.

Set `DELETE_AUDIO_AFTER_TRANSCRIBE=false` to keep audio. It is then deleted `AUDIO_RETENTION_DAYS` after the session is summarized.

### Campaign context
Your campaign files are **git-ignored**, so they're never pushed. The repo only has templates (`campaign/*.example.md`); the bot copies them to the real names on first start, or you can copy them yourself.
- `campaign/glossary.md`: names of characters, NPCs and places. These are fed to Whistle as keywords so it spells them right, and to the summarizer to fix mis-hearings. Foundry actor names are added automatically.
- `campaign/context.md`: setting, party, and the story so far. Sent with every summary.

### Without Discord / Foundry
```sh
cd bot
npx tsx scripts/transcribe-dir.ts ../data/sessions/<id>      # transcribe a session folder (keeps audio unless --delete-audio)
npm run summarize -- <session-id|latest> [--retranscribe]     # transcribe (if needed) + summarize
npm run merge -- <A> <B>                                       # merge continuation session B into A (ids or numbers)
```

In Foundry, journal directory → **Import ScribBot Session**, or from a macro:
`game.modules.get("scribbot-bridge").api.importSummary("latest")`. The same button imports story write-ups (see "Story summaries with any LLM" below).

### If the bot crashes or restarts mid-game
- **Crash or restart while recording:** when the bot starts again (the supervisor in `start.ps1` does that after 5 s), it rejoins the voice channel of any session that was recording less than `RESUME_WINDOW_MINUTES` (30) ago and keeps recording **the same session** on the same clock. It posts "⚠️ ScribBot restarted; recording of session N resumed (gap …)" in the text channel. Speech during the gap isn't recorded. If it can't resume (outside the window, nobody left in the channel, channel gone), it says so right away and the session is marked failed, ready for `/scrib process session:N`.
- **Ctrl+C or closing the bot:** open clips are closed and `timeline.json` is finished before it exits, and the table is told the recording stopped. That session is transcribed automatically when the bot next starts.
- **Lost voice connection:** the bot rejoins by itself (after 2, 5, 10, 20 and 30 s, then every minute) and posts when the connection drops, comes back, or can't be restored. The dashboard shows "rejoining voice" meanwhile.
- **Worker restart:** see step 3 above; nothing is lost and a waiting `/scrib stop` keeps waiting for up to 5 minutes. If the worker falls more than `BACKLOG_WARN_MINUTES` (10) behind during a recording, the bot says so once in the text channel.

Each clip is appended to `timeline.segments.jsonl` as soon as it's recorded; `timeline.json` is a snapshot written every 30 s, on a new speaker and at stop. Readers combine the two, so a crash loses at most the clip being spoken.

### Merging an interrupted game
If a game still ends up as two sessions (a restart after the resume window, or a game deliberately recorded in two parts), merge them. Transcribe both (`/scrib process session:N`), then merge the second into the first with `/scrib merge a:N b:M`, the Console's **Merge into an earlier session…**, or `npm run merge -- N M`. Session M's recording folder moves into session N's `recordings/`, and N's transcript, chat log and actors are rebuilt from both: M's lines on N's clock, a `ScribBot` line at the gap ("recording resumed after 12 min gap"), participants combined, Foundry chat and combats once each. Nothing is copied or deleted: M keeps its own audio (so re-transcribing N redoes both) and its own summary and story are kept beside its recording in `from-session-<M>/`. M is marked "Merged into session N" and no longer listed or processed on its own. Speech while the bot was down was never recorded. Summarize the result with `/scrib summarize session:N`. Both sessions must use the campaign folder layout.

## LLM providers
| `LLM_PROVIDER` | Default model | Key |
|---|---|---|
| `anthropic` | `claude-opus-5-5` | `ANTHROPIC_API_KEY` (or `ant auth login`); `ANTHROPIC_BASE_URL` for a gateway or proxy |
| `xai` | `grok-4` | `XAI_API_KEY`; `XAI_BASE_URL` for another endpoint |
| `openai-compatible` | set `LLM_MODEL` | `OPENAI_BASE_URL` + `OPENAI_API_KEY` (OpenAI, Mistral, DeepSeek, Groq, Together, Fireworks, OpenRouter, Ollama, LM Studio, vLLM) |
| `gemini` | `gemini-3.8-flash` | `GEMINI_API_KEY` (Google AI Studio); `GOOGLE_GEMINI_BASE_URL` for a gateway |
| `vertex-ai` | `gemini-3.8-flash` | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` (blank = `global`) with application default credentials (`gcloud auth application-default login`) or a service account file in `GOOGLE_APPLICATION_CREDENTIALS`; or `GEMINI_API_KEY` alone for express mode |
| `azure-openai` | set `LLM_MODEL` to the deployment name | `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` (or an Entra ID `Authorization: Bearer` header in `LLM_HEADERS`); `OPENAI_API_VERSION` (blank = `2024-10-21`) |
| `bedrock` | set `LLM_MODEL` to a model id or inference profile | `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key), or AWS credentials: `AWS_PROFILE` (keys, SSO, a role) or the default chain; `AWS_REGION`; `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` for a VPC endpoint |
| `codex` | the model in Codex's own config | the OpenAI Codex CLI signed in with `codex login` (a ChatGPT plan) |
| `antigravity` | `gemini-3.8-flash` | the Google Antigravity CLI (`agy`) signed in with a Google account; `agy models` lists the models |
| `claude-code` | the model in Claude Code's own settings | Claude Code (`claude`) signed in with a Claude account; no API key |
| `grok-cli` | the Grok CLI's default (`grok models` lists them) | the xAI Grok CLI (`grok`) signed in with `grok login`; no API key |

Providers that speak OpenAI's Chat Completions API (Mistral, DeepSeek, Groq and the rest) go through `openai-compatible`; Gemini, Vertex AI, Azure OpenAI and Bedrock each have their own provider, through Google's `@google/genai`, the openai SDK's `AzureOpenAI` and the AWS SDK's Bedrock Runtime `Converse` call. Their settings use the names those SDKs read. Bedrock asks for native structured output and, for a model that doesn't support it, falls back to a forced tool call (logged once).

The API settings are freeform, in each API's own terms, so any endpoint, gateway or option it supports works without a ScribBot change. `LLM_MODEL` is any model id the endpoint accepts. Base URLs are the SDKs' own (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, up to `/v1`). `LLM_HEADERS` adds HTTP headers to every request: `Name: value` pairs separated by `;`, or a JSON object, e.g. `HTTP-Referer: https://example.org; X-Title: ScribBot` for OpenRouter, `api-key: <key>` for Azure OpenAI, or a gateway's `Authorization` header (which then stands in for the API key). `LLM_REQUEST_OPTIONS` is a JSON object merged into every request body with the API's own field names: `{"temperature": 0.3}`, `{"max_tokens": 32000}`, `{"max_completion_tokens": 32000, "reasoning_effort": "high"}` for OpenAI reasoning models (ScribBot then leaves out `max_tokens`), `{"provider": {"order": ["anthropic"]}}` for OpenRouter, `{"output_config": {"effort": "high"}}` for Anthropic, `{"thinkingConfig": {"thinkingLevel": "high"}}` for Gemini (merged into its `GenerateContentConfig`), `{"inferenceConfig": {"temperature": 0.2}, "guardrailConfig": {...}}` for Bedrock's `Converse`. They override ScribBot's defaults; `model`, `messages`, `system` and the output format are always ScribBot's (ignored with a `[summarize]` warning). The endpoint rejects fields it doesn't know. Mistakes in either are reported by `/status` and **Test summaries**, and refused by the Console when saving; neither is shown back by `/status`. The CLI providers don't use them.

`codex`, `antigravity`, `claude-code` and `grok-cli` run the CLI once per summary pass (`codex exec`, `agy --print`, `claude -p`, `grok --prompt-file`) in an empty temp folder with its sandbox on (Claude Code runs with no tools, MCP servers, skills, hooks or settings files, and doesn't save the session; not `--bare`, which would ignore the Claude sign-in. Grok runs with no tools, web search, subagents or plan mode, in `dontAsk` permission mode), the prompt on stdin and the JSON Schema enforced by the CLI. Usage counts against that account's plan, not an API key. Each run starts an agent, so summaries take longer than through an API. The CLI gets none of ScribBot's environment (so no Discord token, API token, Foundry password or API key): only `PATH`, the home and temp folders, locale, proxy and CA settings, `XDG_*`, the D-Bus address on Linux `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. It is started without a shell, as an absolute path. An npm install's Windows wrapper (`codex.cmd`) is run as `node <its script>` with the bot's Node, never through `cmd.exe`; other `.cmd`, `.bat` and `.ps1` files are refused. Set `LLM_CLI_PATH` (an `.exe`, a program, or a `.js` file) when the CLI isn't on the bot's `PATH` as `codex`, `agy`, `claude` or `grok`; `/status` only checks that it can be found, not that it's signed in. The effort hint becomes Codex's `model_reasoning_effort` or `agy --effort` (left out for Antigravity model ids that already name a level, like `gemini-3.8-flash-high`).

Long sessions are summarized in two passes. Each ~25-minute chunk (`SUMMARY_CHUNK_MINUTES`) is turned into structured notes, separating in-character from out-of-character speech. The notes are then merged into the final summary. Output is schema-constrained JSON (see `shared/schemas/`).

### Story summaries with any LLM (agent skill)
`.claude/skills/summarize-session/` writes a high-fantasy, story-style write-up in a fixed section order (high level summary, characters with class, level and player from Foundry, named NPCs, objectives completed, then the full story), plus a brief table-talk summary, of a session (`story/summary.story.md` in the session's folder; all its recordings are stitched) with any model, separate from `/scrib summarize`:
```sh
python .claude/skills/summarize-session/prepare.py <number|id|latest> [more sessions to stitch]   # drop Whisper hallucinations, build the evidence pack
python .claude/skills/summarize-session/verify.py data/campaigns/<world>/sessions/<session id>/story/summary.story.md       # check quotes, layout, real names and damage numbers
```
If the transcript uses nicknames or names of people who aren't in Discord or Foundry ("Becca", "Robbie"), `prepare.py` stops with exit code 2 and suggests who each one is. Confirm with `--nickname "Becca=Alessandra Deiana"` (or `absent` / `not-a-person`), or answer the prompts when run in a terminal. Answers are kept in `data/nicknames.json`. `prepare.py` starts `summary.story.md` from the skill's `template.md` (whose headings fix the sections) and never overwrites one that exists; delete it to start over. The pack names the Foundry game system and the spells and abilities cast, so the story can name the spells that turn a scene (Implosion, Power Word Blind) while telling the rest by their effect. `PROMPT.md` holds the instructions for the writing model. See the skill's `SKILL.md` for small-context models and the hallucination rules.

Import a finished story into Foundry with `/scrib story [session]` (default: the latest session with one), the journal directory's **Import ScribBot Session** button (pick "story"), `POST /sessions/<id>/story/import`, or a macro: `game.modules.get("scribbot-bridge").api.importStory("latest")`. It becomes its own journal entry, "Session 12 + 13: <title>", one page per section, in the same folder and with the same player permissions as summaries; importing again replaces its pages. A story stitched from two sessions is found from either. Images on a line of their own next to the story (`![alt](banner.png)`) are copied into Foundry's User Data as `scribbot/<session id>/<file>`, one folder per session, by the bridge client, which needs Foundry's **Upload New Files** permission (GMs have it; for a player or the headless ScribBot user, allow it in User Management). Foundry lets only GMs create folders, so a player bridge asks the GM's client to create the session's folder; with no GM online the images go into the world's `assets` folder as `scribbot-<session id>-<file>`. Without upload permission the story is imported without images. Needs module 0.6.2 or later.

## Development
```sh
cd bot && npm test && npm run typecheck      # vitest (also tests foundry-module/scripts/journal.js)
cd worker && .venv\Scripts\python -m pytest
cd console && ..\worker\.venv\Scripts\python -m pytest
cd bot && npm run schemas                    # regenerate shared/schemas from the zod definitions
```
