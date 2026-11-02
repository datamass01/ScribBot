# ScribBot Console: design proposal

| | |
|---|---|
| **Status** | Implemented on 2026-11-01 (branch `feature/console`). `docs/design.md` §9.2 and §9.2a describe what was built; this page keeps the reasoning. Not built: `CONSOLE_PASSWORD` (§5), not needed while the Console runs locally. The journal confirmation (open question 2) is built as `POST /sessions/:id/journal` |
| **Replaces** | `monitor/scribmonitor.py` (watchdog). Adds a desktop management and setup page; the `/scrib` slash commands, the Foundry module's dialogs and the bot's dashboard all stay |
| **Priorities** | Stability and efficiency first. The Console is for easier management and setup, and must never cost the bot a recording or a capability |
| **Read with** | `docs/design.md` (current architecture) |

## 1. Why

Today, running ScribBot means typing `/scrib` commands in Discord, watching two different pages (the bot's dashboard on `:7420`, or the watchdog on `:7422` while the bot is down), and editing `.env` by hand. The GM has to know `/scrib process session:12 retranscribe:true`, `npm run merge`, or `Invoke-RestMethod … /resume`.

The Console is one local web app, built from the monitor, with three tabs:

| Tab | Job |
|---|---|
| **Sessions** (default) | Create, stop, resume, re-run, merge and delete sessions; post summaries and stories to Foundry journals; manage who plays which character |
| **Monitoring** | What the watchdog and the bot's dashboard show today, in one page that works whether the bot is up or down |
| **Configuration** | A form for `.env`, with labels, help text, validation, masked secrets and "restart needed" prompts |

## 2. What doesn't change

- **The bot stays the recorder.** Discord sends voice audio only to a connected bot client, so recording, the pipeline, the Foundry bridge and the headless Foundry client all stay in `bot/`. The Console *drives* the bot. It does not replace it.
- **The worker is unchanged.**
- **Discord and Foundry keep every capability they have.** All `/scrib` subcommands, the Foundry module's import dialog, **Link Discord accounts** menu and auto-import stay first-class. Anything the Console can do that the table needs mid-game (start, stop, map) must stay possible from Discord. The Console adds a desktop view; it is not the only way in.
- **The bot and worker never depend on the Console.** If the Console is closed, recording, transcription and Foundry imports carry on. This is the monitor's "nothing may depend on it" rule, kept in the other direction.
- **No new work on the recording path.** Admin routes run on the bot's event loop, so they must be cheap and must not throw: long jobs return 202 and run the same queued code the slash commands use. Restart, delete and merge are refused while a recording or processing is live.
- **No new polling load.** The Console's sampler keeps its single shared `/status` call (1.5 s cache, 5 s interval), and the browser polls the Console, never the bot. A closed Console tab costs nothing.
- **Consent.** Starting a recording from the Console still posts the recording notice in the Discord text channel.

## 3. Architecture

```
 Browser (127.0.0.1:7422)
    │  same-origin fetch only, no token in the page
    ▼
 ┌──────────────────────── Console (Python, :7422) ───────────────────────┐
 │  Sessions API ─┐   Monitoring (today's Monitor class)   Config editor │
 │                │        │ reads                            │ writes   │
 └────────────────┼────────┼──────────────────────────────────┼──────────┘
     Bearer token │        │ read-only                        ▼
                  ▼        ▼                                 .env (+ .env.bak)
   Bot :7420  /admin/*   data/scribbot.db (mode=ro), session folders (stat/read)
     │  owns DB writes, session folders, Discord, Foundry bridge
     ▼
   Worker :7421 (/health, /pause, /resume, called by both)
```

### 3.1 Who writes what

The rule: **every file has one writer.** It's what keeps the current design safe across crashes, and the Console doesn't break it.

| Data | Writer | Console access |
|---|---|---|
| `data/scribbot.db`, session folders, `foundry-actors.json` | Bot | Read-only; changes go through `/admin/*` |
| `.env` | **Console** (new) | Read and write (bot and worker read it only at startup) |
| `campaign/glossary.md`, `context.md` | Console (new, optional editor) | Read and write; the bot reads them per session |
| Worker queue | Worker | `POST /pause`, `/resume` |
| `data/logs/console-*.log` | Console | Its own audit log of every action taken |

So the Console never opens the SQLite database for writing, and never moves or deletes files under `data/sessions/`. When the bot is down, the Sessions tab is read-only and says why. Only the Configuration tab and Monitoring keep working fully.

### 3.2 New bot admin API (`/admin/*` on :7420)

The bot's HTTP API is read-only today, apart from Foundry's uploads. The Console needs these actions. Each one is a thin wrapper around code the slash commands already run, so both interfaces behave the same.

| Method and path | Does | Reuses |
|---|---|---|
| `GET /admin/discord/channels` | Guilds, voice channels (with who's in them), text channels the bot can post in | discord.js cache |
| `POST /admin/sessions` `{guildId, voiceChannelId, textChannelId}` | Start recording | `start()` body, refactored out of the interaction |
| `POST /admin/sessions/:id/stop` | Stop recording | `stop()` |
| `POST /admin/sessions/:id/process` `{retranscribe?}` | Resume or redo | `processSession()` |
| `POST /admin/sessions/:id/summarize` | Re-run the summary only | same as `/scrib summarize` |
| `POST /admin/sessions/:id/summary/import` | Send the summary to the Foundry journal (re-emit `summary.ready`) | new, mirrors `story/import` |
| `POST /admin/sessions/:id/story/import` | Send the story write-up to the journal | `announceStory()` (alias of the existing route) |
| `POST /admin/sessions/:id/merge` `{into}` | Merge a continuation session | `mergeSessions()` |
| `PATCH /admin/sessions/:id` `{title?, notes?}` | Label a session | new columns |
| `DELETE /admin/sessions/:id` | Move to trash (§4.3) | new |
| `POST /admin/sessions/:id/restore`, `DELETE /admin/trash/:id` | Undo a delete, or empty the trash for that session | new |
| `GET/PUT/DELETE /admin/mappings…` | Map, unmap, GM flag | `store.*Mapping`, `roster.link` |
| `POST /admin/maintenance/purge-audio` | Run audio retention now | `purgeExpiredAudio()` |
| `POST /admin/foundry/test` | Join Foundry once, report the result | `npm run foundry` logic |
| `POST /admin/llm/test` | One tiny structured call to the configured provider | `LLMProvider` |
| `POST /admin/restart` | Clean shutdown, exit with code 75 so `start.ps1` restarts it | shutdown path; refused while recording |

**Errors.** Each route returns `{ ok: false, error, hint }` with the same wording the slash command would use. For example, starting a second recording in a guild returns 409 with "Already recording in this server".

**Long jobs.** `process`, `summarize` and `merge` return `202 { sessionId }` straight away. Progress comes from `/status` (already there: `processing`, `progress`) and the WebSocket.

**Lock-down.** `/admin/*` needs the bearer token, accepts only loopback peers, and rejects any request with an `Origin` header. The Console calls it from Python, so no browser (including Foundry's page, which is in `FOUNDRY_ORIGINS`) can reach it, even with the token.

### 3.3 Console process

| Concern | Choice | Why |
|---|---|---|
| Location | `console/` (package `scribconsole`), with the monitor's logic moved in as `scribconsole/monitoring.py` | "Based off the monitor": its `Config`, `Monitor`, `LogFile` and tests carry over almost unchanged |
| Server | Python standard library (`ThreadingHTTPServer`), as the monitor is today | The Console is the setup tool, so it must run on a fresh machine with any Python 3.10+, before the worker's venv or `npm install` exist. It also has no dependencies to break on upgrade, and little memory or startup cost. Validation is small and hand-written against `config.schema.json` |
| Front end | One `index.html` plus plain ES modules, no build step | Same as the Foundry module and the bot's dashboard |
| Port | `CONSOLE_PORT` (default 7422; falls back to `MONITOR_PORT`) | Bookmarks keep working |
| Start | `start-console.ps1` (replaces `start-monitor.ps1`, which stays as a shim for one release) | |
| Background | The monitor's 5 s sampler keeps running (rate history, crash detection, log copy) | Unchanged |

## 4. Tabs

### 4.1 Sessions (default)

```
┌ Sessions ─ Monitoring ─ Configuration ──────────────────── bot ● worker ● foundry ○ ┐
│ [● New recording]   Show: (All) Active  Failed  Trash         Search [            ] │
├─────┬────────────┬───────────────┬────────┬──────────────────────────┬──────────────┤
│  #  │ Date       │ Title         │ Status │ Files                    │              │
│ 14  │ 2026-10-31 │ —             │ ●REC   │ 312 clips · 5 speakers   │ [Stop]       │
│ 13  │ 2026-10-24 │ The Sunken... │ done   │ transcript summary story │ [⋯]          │
│ 12  │ 2026-10-17 │ —             │ failed │ transcript               │ [Resume] [⋯] │
└─────┴────────────┴───────────────┴────────┴──────────────────────────┴──────────────┘
 ⋯ = Re-transcribe · Summarize · Post summary to Foundry · Post story to Foundry ·
     Merge into… · Rename · Delete
```

- **New recording** opens a dialog: guild (hidden when there's only one), a voice channel with its current members shown, a text channel for notices (defaulting to the last one used), and a preview of who maps to which character. It then calls `POST /admin/sessions`.
- **Row actions** are enabled or disabled by state, and the disabled ones say why. "Re-transcribe" is off with "audio was deleted after transcription" when `audioPurged`, or when `DELETE_AUDIO_AFTER_TRANSCRIBE` removed it. "Summarize" is off with the reason when LLM credentials are missing. Merged sessions show "Merged into #N" and offer no pipeline actions.
- **Session detail** (click a row): a timeline strip, speakers and their characters, transcript preview (`transcript.md`), summary preview, chat log counts, the story's `verify.py` result, file list with sizes, and the session's log lines (filtered by session id).
- **Journal posting**: shows when the summary or story was last sent to Foundry, and whether a bridge client was connected at the time. If not, it shows "queued for the next GM login" (the headless client's pending list).
- **Players & characters** (a sub-panel): the `/scrib map`, `unmap` and `gm` table, with the Foundry roster as a picker. This replaces `/scrib mappings`.

### 4.2 Monitoring

Today's offline page and the bot's dashboard merged into one page, fed by the Console's `/status`. That endpoint already returns the bot's shape when it's up and the offline stand-in when it's down, plus `monitor.pipeline`. The redirect to `:7420` goes. Sections: alerts and warnings, the shutdown verdict, recordings (connection state, clips, speakers), the worker queue (depth, rate, ETA, stalled or paused, with **Pause** and **Resume** buttons), per-session conversion and quality, Foundry bridge state, disk, and a live log tail.

The bot's own `dashboard.html` stays as it is. It needs no Console, which is useful when only the bot is running. It gets a link to the Console and no new features.

### 4.3 Deleting a session

Deleting is the one destructive action, so it's a soft delete:

1. The dialog asks you to type the session number. It also warns if a summary or story was posted to Foundry, since Foundry journals aren't touched.
2. The bot refuses while the session is recording or processing. Otherwise it moves `data/sessions/<id>/` to `data/trash/<id>/` and sets `deleted_at`. The row stays, so per-guild session numbers are never reused, and merges still resolve.
3. The Trash filter lists deleted sessions with **Restore** and **Delete permanently**. Trash is emptied automatically after `TRASH_RETENTION_DAYS` (default 30, 0 = never).

### 4.4 Configuration

```
┌ Configuration ───────────────────────────────────────────────────────────────────┐
│ Discord | Foundry | Transcription | Summaries | Storage & retention | Advanced    │
├──────────────────────────────────────────────────────────────────────────────────┤
│ LLM provider        (Anthropic ▾)                                       bot ↻    │
│ Model               [               ]  blank = claude-opus-5-5          bot ↻    │
│ Anthropic API key   ●●●●●●●● set   [Replace] [Clear]   [Test]           bot ↻    │
│ Auto-summarize      [ ] Send every transcript to the LLM when it's done bot ↻    │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 2 unsaved changes                      [Discard]  [Save]                          │
│ ⚠ Saved. The bot needs a restart to apply them.   [Restart bot] (off: recording)  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**One schema, not three copies.** The Console doesn't hard-code the variables. `npm run schemas` gains an export of the bot's Zod env schema to `shared/schemas/config.schema.json`, with each field's group, label, help text, type, default, whether it's a secret, and which process reads it (bot, worker, console). The worker-only variables (`STT_ENGINE`, `WHISPER_*`, …) are added to the same Zod schema, marked `worker`, so there is still one source of truth. The Console renders the form from that file, and validates on the server with the same rules before writing.

**Editing `.env` safely.**
- *Round-trip edits.* The file is parsed into lines, and only the values of changed keys are replaced. Comments, blank lines, ordering and unknown keys are kept. Keys that are new to the file are appended under their group's comment header from `.env.example`.
- *Atomic write.* Write `.env.tmp`, keep the previous file as `.env.bak`, then rename.
- *Secrets are write-only.* `DISCORD_TOKEN`, `API_TOKEN`, `*_API_KEY` and `FOUNDRY_PASSWORD` are never sent to the browser. The page sees `set` or `not set` and can replace or clear a value. `API_TOKEN` gets a **Generate** button, and a note that the Foundry module setting must change to match.
- *Environment wins.* Like dotenv, a real environment variable overrides `.env`. Such fields show "Overridden by the environment" and are read-only.
- *Applying changes.* Each field is tagged with the process that reads it. After a save, the Console lists which processes need a restart. **Restart bot** calls `/admin/restart`, which is refused while recording. **Restart worker** asks the worker to exit 75; its supervisor restarts it and the queue is re-queued from disk on start. Console-only settings apply immediately.
- *Test buttons* for the LLM, Foundry login and worker, using the admin routes above.
- *Protect the speed tuning.* The worker's tuned settings (`WHISPER_BEAM_SIZE`, `WHISPER_MAX_HOTWORDS`, `WHISPER_HOTWORDS_MIN_SECONDS`, `WHISPER_VAD`, the VAD threshold and the filler filter) sit in a collapsed **Advanced** section. Each one shows its tuned default and has **Reset to default**. A value known to slow transcription or hurt accuracy (VAD off, more than 30 hotwords, a wider beam, Whisper on the CPU) shows a warning, and saving it asks for confirmation first.

Optionally, a **Campaign** section edits `campaign/glossary.md` and `context.md` as plain text, with the same atomic write.

**Setup checklist.** At the top of the tab, a list of checks, each with a fix-it hint, that works with nothing else running:

| Check | How |
|---|---|
| `.env` exists | Offer to create it from `.env.example` |
| Node 22+, `bot/node_modules` | `node --version`, folder present |
| Worker venv and STT weights | `worker/.venv` present, worker `/health` `loadError` |
| Discord token valid, bot invited to the guild | Bot `/status` `discord` block (needs the bot) |
| API token not `change-me` and matching Foundry | `/status` warnings, Foundry socket count |
| Foundry module installed and bridge user connected | `/status` `foundry` block |
| LLM credentials (only if `AUTO_SUMMARIZE` or summaries are wanted) | `POST /admin/llm/test` |

The checks only read state and run the existing test calls. Installing packages stays in the README's steps.

## 5. Security

Once the Console can delete sessions and write secrets, it needs more protection than a read-only monitor did.

- Binds `127.0.0.1` only, with the monitor's `Host` check (DNS rebinding).
- **CSRF**: every mutating request must be `POST`/`PUT`/`PATCH`/`DELETE` with `Content-Type: application/json`, carry a matching `Origin` (or none), and include an `X-Scrib-Console` header. No CORS headers are ever sent. A cross-site form or `fetch` can't satisfy all three.
- Optional `CONSOLE_PASSWORD` for shared PCs: a login form and an HttpOnly, SameSite=Strict session cookie. Off by default, because the threat model is a single-user machine.
- `API_TOKEN` and other secrets stay server-side, as the monitor already does.
- Every action is written to `data/logs/console-YYYY-MM-DD.log` with what was changed. Config changes log the key names, never the values.

## 6. Data model changes

SQLite migration (bot):

| Column | Purpose |
|---|---|
| `sessions.title`, `sessions.notes` | GM-editable labels (the summary title is the default) |
| `sessions.deleted_at` | Soft delete (§4.3) |
| `sessions.summary_posted_at`, `sessions.story_posted_at` | When it was last sent to Foundry. Set on emit; the module's ack (open question 4) would make it "confirmed" |

New: `data/trash/`, and `shared/schemas/config.schema.json`.

## 7. Delivery plan

Each phase ships on its own and keeps all test suites green.

The order puts the parts that need no bot changes first. They are the easiest to set up and the least risky.

1. **Console skeleton and Monitoring tab.** Create `console/`, move the monitor code and its tests unchanged, serve the tabbed page, and port `offline.html` plus the useful panels of `dashboard.html` into the Monitoring tab. Add `start-console.ps1`. No bot change.
2. **Configuration tab and setup checklist.** Config schema export, `.env` round-trip editor (with tests on real `.env.example` round-trips), secrets handling, the checklist. The only bot change is the schema export.
3. **Bot admin API.** Extract the start, stop, process, summarize and merge bodies from `commands.ts` into a `SessionService` with **no change in behavior**. The slash command tests must pass untouched before any `/admin` route is added. Then add the routes, delete/trash, the migration, and restart with exit code 75 (`start.ps1` and `start-worker.ps1` treat 75 as "restart now"). Add vitest coverage for each route, including the loopback/Origin lock-down, and a test that a route failing during a recording leaves the recorder untouched.
4. **Sessions tab.** List, detail, actions, new-recording dialog, mappings, trash.
5. **Clean-up.** README and `design.md` (new §9.2a, §12 variables `CONSOLE_PORT`, `CONSOLE_PASSWORD`, `TRASH_RETENTION_DAYS`), architecture diagram, `start-monitor.ps1` shim, and a Console link on the bot dashboard.

## 8. Open questions

Decided on 2026-11-01: slash commands and Foundry dialogs keep every capability; the bot dashboard stays; the Console stays on the standard library.

1. **Start and stop from the web.** Recommended: yes, as well as `/scrib start` and `stop`, not instead of them. The alternative is to keep start/stop in Discord only, so a recording is always started by someone present in the channel.
2. **Journal confirmation.** Today the bot emits `summary.ready` and doesn't learn whether a journal was created. A small module change (`POST /sessions/:id/journal-ack`) would let the Sessions tab show "in Foundry ✓" instead of "sent".
3. **Process supervision.** Should the Console also *start* the bot and worker (replacing the `start*.ps1` console loops), or only restart them through their supervisors? Recommended: only restart, for now. Owning the process tree is a bigger change (see "The supervisor is a console loop" in `design.md` §14).
