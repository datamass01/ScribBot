# ScribBot design document

| | |
|---|---|
| **Status** | Living document, describes the code as of 2026-10-31 |
| **Components** | `bot/` (Node.js), `worker/` (Python), `foundry-module/` (FoundryVTT), `shared/schemas/` |
| **Audience** | Contributors and anyone deploying ScribBot for their table |

## 1. Purpose

ScribBot turns a tabletop RPG session played over Discord into a written record in FoundryVTT. It:

1. records each speaker in a Discord voice channel separately,
2. transcribes the audio locally on the CPU with Cactus Whistle,
3. labels every line with the speaker's Foundry character,
4. has an LLM write a structured adventure summary, merging speech with Foundry's dice rolls and combat log,
5. posts the summary to Discord and imports it into Foundry as a journal entry.

### Goals

- **No diarization needed.** Discord delivers one audio stream per user, so attribution is exact.
- **Audio stays local.** Speech-to-text runs on the GM's machine. Only transcript text goes to the configured LLM provider.
- **Faithful summaries.** Quotes are machine-checked against the transcript. Invented quotes are dropped.
- **Resumable.** Every stage writes its output to disk. A crash or a provider outage costs a retry, not a session.
- **Runs on a GM's PC.** No GPU, no cloud services other than Discord and the chosen LLM.

### Non-goals

- Real-time captions or live summaries during play.
- Multi-host or horizontally scaled deployments. One bot process serves one machine.
- Hosting audio or transcripts for players. Foundry's journal and Discord are the distribution channels.

## 2. Software stack

### Bot (`bot/`)

| Concern | Technology | Version |
|---|---|---|
| Runtime | Node.js | ≥ 22.12 (tested on 24.x) |
| Language | TypeScript (ES modules), run with `tsx` | 5.9 / tsx 4.23 |
| Discord gateway and slash commands | discord.js | 14.27 |
| Voice receive | @discordjs/voice | 0.19 |
| Opus decoding | prism-media + opusscript | 1.3 / 0.0.8 |
| HTTP API and WebSocket | Fastify + @fastify/websocket + @fastify/cors | 5.12 / 11.3 / 11.3 |
| Persistence | SQLite via better-sqlite3 (WAL mode) | 13.0 |
| Validation and JSON schemas | Zod | 4.6 |
| LLM: Anthropic | @anthropic-ai/sdk (structured outputs via `betaZodOutputFormat`) | 1.1 |
| LLM: xAI and OpenAI-compatible | openai SDK | 7.43 |
| Configuration | dotenv + Zod-validated env schema | 18.0 |
| Tests | Vitest | 5.0 |

### Transcription worker (`worker/`)

| Concern | Technology | Version |
|---|---|---|
| Runtime | Python | ≥ 3.10 (tested on 3.13) |
| Speech-to-text | Cactus Whistle (17 MB, Apache-2.0) through `cactus-needle` | 3.2.8 |
| HTTP API | FastAPI on uvicorn | 0.161 / 0.54 |
| Models and validation | Pydantic | 2.14 |
| Audio arrays | NumPy | 2.5 |
| Tests | pytest + httpx | 9.1 |

### FoundryVTT module (`foundry-module/`)

| Concern | Technology |
|---|---|
| Platform | FoundryVTT v12 (minimum) to v13 (verified) |
| Code | Browser JavaScript ES modules (`scripts/main.js`, `scripts/journal.js`), no build step |
| Transport | `fetch` with a bearer token, plus a native `WebSocket` to the bot |
| Storage | Foundry settings (client scope for URL and token) and user flags (`discordId`) |

### Cross-cutting

| Concern | Technology |
|---|---|
| Data contracts | JSON Schema files in `shared/schemas/`, generated from the Zod types with `npm run schemas` |
| Monitoring UI | Single static page `bot/public/dashboard.html` (plain HTML/JS, polls `/status` every 3 s) |
| LLM providers | Anthropic Claude (default `claude-opus-5-5`), xAI Grok (`grok-4`), or any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, OpenRouter) |

## 3. Architecture

![Component architecture](diagrams/architecture.svg)

ScribBot is three processes plus Foundry:

| Process | Responsibility | Listens on |
|---|---|---|
| **Bot** (`bot/src/index.ts`) | Discord client, voice recording, pipeline orchestration, summarization, API for Foundry, dashboard | `127.0.0.1:7420` |
| **Worker** (`worker/scribworker`) | Loads Whistle once and transcribes clips on a single background thread | `127.0.0.1:7421` |
| **Foundry module** | Runs in the GM's browser. It pushes the roster and chat log to the bot and pulls summaries into the journal | (client only) |
| **LLM provider** | Remote or local model behind `LLMProvider.generateJson()` | (external) |

### 3.1 Bot modules

| Module | Role |
|---|---|
| `commands.ts` | `/scrib` slash command handler. Owns the map of active recordings (one per guild) and posts results to Discord. |
| `recorder.ts` | `SessionRecorder`: joins voice muted, subscribes to each speaker, and writes one WAV per speech burst plus `timeline.json`. |
| `pipeline.ts` | `processSession()` runs transcription, then summarization, and updates session status. `makeLiveTranscriber()` sends clips during play. `purgeExpiredAudio()` enforces retention. |
| `worker-client.ts` | HTTP client for the worker: fire-and-forget clip jobs, and session jobs polled every second. |
| `summarize/` | Prompt building, chunking, provider adapters, quote verification and Markdown rendering. |
| `participants.ts` | Resolves a Discord user to a Foundry character (see §7). |
| `db.ts` | `Store`: SQLite access with versioned migrations. |
| `events.ts` | In-process `EventEmitter` bus. Its events are forwarded to Foundry over the WebSocket. |
| `api/server.ts`, `api/status.ts` | Fastify routes, token auth, CORS, and `/status` health aggregation with warnings. |
| `monitor.ts` | Captures console output into a ring buffer for `/logs` and the dashboard. |
| `campaign.ts` | Loads `campaign/glossary.md` and `context.md` and builds STT keyword lists. |

## 4. Session lifecycle

![Recording session sequence](diagrams/session-sequence.svg)

1. **Start.** `/scrib start` creates a session row (`recording`), joins the caller's voice channel muted and undeafened, posts a recording notice with the speaker-to-character map, and emits `session.started`.
2. **During play.** Each `speaking.start` opens an Opus subscription that ends after 800 ms of silence. The clip is decoded to 16 kHz mono and written as `audio/<userId>/<startMs>.wav`. `timeline.json` is rewritten atomically *before* the clip is handed to the worker, so the timeline always lists clips that may later be deleted. With `DELETE_AUDIO_AFTER_TRANSCRIBE=true`, the clip is transcribed immediately and its WAV deleted.
3. **Stop.** `/scrib stop` flushes open streams, finalizes the timeline, and emits `session.stopped`. The active GM's Foundry module responds by uploading the chat, roll and combat log for the session's time window.
4. **Transcribe.** The bot submits a session job. The worker reuses every cached clip result, transcribes any leftovers (for example, clips recorded while it was down), and writes `transcript.json` and `transcript.md`.
5. **Summarize.** Two LLM passes produce `summary.json`, and quotes are verified (see §8).
6. **Deliver.** The bot posts an embed with `summary.md` attached, and emits `summary.ready`. If auto-import is enabled, the module fetches the summary and transcript and creates or replaces a `JournalEntry` in the configured folder.

### 4.1 Session status

![Session status lifecycle](diagrams/session-states.svg)

The status is stored in `sessions.status` and broadcast as `session.status` events. On startup, any session left in `recording`, `transcribing` or `summarizing` is marked `failed` with a hint to run `/scrib process`. Because each stage checks for its output file before running, resuming never redoes finished work.

## 5. Data pipeline

![Data pipeline](diagrams/pipeline-flow.svg)

### Key parameters

| Parameter | Value | Where |
|---|---|---|
| Sample rate | 16 kHz mono, 16-bit PCM | `recorder.ts` (`SAMPLE_RATE`) |
| End-of-utterance silence | 800 ms | `recorder.ts` (`SILENCE_MS`) |
| Minimum clip length | 250 ms | `recorder.ts` (`MIN_SEGMENT_MS`) |
| STT keywords | up to 150 (characters, glossary, Foundry actors) | `campaign.ts` (`sttKeywords`) |
| Summary chunk length | 25 min (`SUMMARY_CHUNK_MINUTES`) | `summarize/format.ts` |
| Chunk concurrency | 3 | `summarize/summarize.ts` |
| Quote match threshold | 0.8 word coverage, windows of up to 3 lines by the same speaker | `summarize/quotes.ts` |

## 6. Data model

### 6.1 Session folder (`data/sessions/<id>/`)

| File | Writer | Contents | Lifetime |
|---|---|---|---|
| `timeline.json` | Bot | Participants, segments (`discordId`, `startMs`, `endMs`, `file`) | Kept |
| `audio/<user>/*.wav` | Bot | One clip per speech burst | Deleted on transcription, or `AUDIO_RETENTION_DAYS` after summary |
| `transcript.partial.jsonl` | Worker | Per-clip STT cache (append-only) | Removed once `transcript.json` is written |
| `transcript.json` / `.md` | Worker | Timestamped lines with speaker, character and GM flag | Kept |
| `chatlog.json` | Bot (from Foundry) | Chat messages, rolls, combats | Kept |
| `notes.json` | Bot | Pass 1 chunk notes | Kept |
| `summary.json` / `.md` | Bot | Final summary plus `droppedQuotes`, provider and model | Kept |

All JSON contracts are defined in Zod (`bot/src/types.ts`, `bot/src/summarize/schema.ts`) and exported to `shared/schemas/*.schema.json`. The worker mirrors them in Pydantic (`worker/scribworker/models.py`).

### 6.2 SQLite (`data/scribbot.db`)

| Table | Key | Purpose |
|---|---|---|
| `sessions` | `id` | Guild, channels, per-guild `number`, `status`, `error`, timestamps, `audio_purged` |
| `mappings` | `(guild_id, discord_id)` | Manual `/scrib map` and `/scrib gm` assignments |
| `roster` | `foundry_user_id` | Latest Foundry users with their assigned actor and Discord ID flag |

Migrations are an ordered array applied by `PRAGMA user_version`.

## 7. Speaker identity

Discord streams are tagged by user ID, so the only problem is mapping a user to a character. `resolveParticipant()` applies, in order:

1. an explicit `/scrib map` for that guild (character name or actor),
2. the Foundry user they are mapped to, and that user's assigned character,
3. a Foundry user whose `discordId` flag matches them (set in the module's **Link Discord accounts** menu),
4. otherwise, their Discord display name.

GMs (by `/scrib gm` or Foundry's `isGM`) are labelled `GM (Name)`. The prompt tells the model that the GM narrates and voices all NPCs. Bots in the channel are ignored.

## 8. Summarization design

- **Provider abstraction.** `LLMProvider.generateJson({system, prompt, schema, effort})` returns schema-validated JSON. The Anthropic adapter uses structured outputs with server-side fallback for classifier refusals. The OpenAI-compatible adapter serves xAI and local models.
- **Event stream.** Transcript lines and Foundry events (`[FOUNDRY ROLL]`, chat, combat start and end) are merged into one time-ordered stream, so the model can anchor fights and checks to reliable mechanical facts.
- **Two passes.** Pass 1 turns each chunk into `ChunkNotes` (scenes, events, combats, in-character quotes, NPCs, loot, threads). Pass 2 merges all notes, with combat round counts from Foundry, into the final `Summary`. This keeps each prompt bounded however long the session is.
- **In-character filtering.** The system prompt separates in-character speech from table talk and requires character names, never player names.
- **Quote verification.** Each quote is scored by the longest common subsequence of words against windows of 1 to 3 consecutive lines by the same speaker (Whistle splits sentences at pauses). Quotes scoring below 0.8 are moved to `droppedQuotes`. In-character Foundry chat is also a valid quote source.
- **Campaign context.** `context.md` (setting, party, story so far) and `glossary.md` go into every prompt, so the model can correct misheard names.

## 9. Interfaces

### 9.1 Slash commands

| Command | Effect |
|---|---|
| `/scrib start` / `stop` | Begin or end recording in the caller's voice channel |
| `/scrib map @user <character>`, `unmap`, `gm @user` | Manage speaker mappings (autocompletes from the Foundry roster) |
| `/scrib mappings`, `status`, `sessions` | Information |
| `/scrib process [session] [retranscribe]` | Resume a failed session or redo it |
| `/scrib summarize [session]` | Re-run only the summary |

### 9.2 Bot HTTP API (`:7420`)

Every route except `/health`, `/` and `/dashboard` requires `Authorization: Bearer <API_TOKEN>`, or `?token=` for the WebSocket, because browsers can't set headers on upgrades.

| Method and path | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /`, `/dashboard` | Monitoring page (the token is entered in the page) |
| `GET /status`, `GET /logs?after=<seq>` | Component health, warnings, sessions, and log lines |
| `GET /ws` | WebSocket: `hello`, `session.started`, `session.stopped`, `session.status`, `summary.ready`, `roster.request` |
| `POST /roster` | Foundry users, assigned characters, Discord ID flags and actor names |
| `GET /sessions`, `GET /sessions/:id` | Session list and detail (`:id` may be `latest`) |
| `POST /sessions/:id/chatlog` | Upload chat, roll and combat log (body limit 25 MB) |
| `GET /sessions/:id/summary`, `/transcript` | Serve `summary.json` and `transcript.json` |

### 9.3 Worker HTTP API (`:7421`)

| Method and path | Purpose |
|---|---|
| `GET /health` | Model, device, language, queue depth, live clip counters |
| `POST /clips/transcribe` | Queue one clip (returns 202). Idempotent through the cache |
| `POST /jobs/transcribe` | Build the full transcript for a session folder. Returns a job ID |
| `GET /jobs/:id` | Job status and progress |

The worker rejects any `sessionDir` outside `DATA_DIR`, and any language outside the supported set (en, de, fr, es, it, nl, pl).

## 10. Security and privacy

- **Consent.** `/scrib start` posts a recording notice. Groups must agree to be recorded before play.
- **Local audio.** WAVs never leave the machine. By default each one is deleted seconds after it's transcribed.
- **Network exposure.** Both services bind to `127.0.0.1`. Remote Foundry hosts (Forge and others) work because browsers treat `http://localhost` as a secure origin. To expose the bot elsewhere, put it behind an HTTPS proxy or tunnel.
- **Authentication.** A shared `API_TOKEN` is compared with `timingSafeEqual`. `/status` warns while it is still `change-me`. The token is stored only in each GM's browser (Foundry client-scope setting) and never returned by the API.
- **CORS.** Only `FOUNDRY_ORIGINS` is allowed, with methods limited to GET and POST.
- **Path safety.** Session IDs are resolved through the database before any file access. The worker confines paths to `DATA_DIR`.
- **Secrets in status.** `/status` reports which kind of credential each provider has (for example `api key` or `ant profile`), never the value. A provider without credentials raises a warning before the session ends, not when summarizing fails.
- **LLM data.** Transcript text and campaign notes go to the configured provider. A local OpenAI-compatible model keeps everything on the machine.

## 11. Reliability

| Failure | Handling |
|---|---|
| Worker down during play | Live clip calls fail silently (one log line). The session job at stop transcribes the waiting WAVs. |
| Worker or bot crash mid-transcription | `transcript.partial.jsonl` keeps finished clips, so only the rest are redone. |
| Bot restart mid-session | Session marked `failed`. `/scrib process` resumes from what is on disk. |
| LLM error, rate limit or refusal | Session marked `failed` with the error posted to Discord. `/scrib summarize` retries without re-transcribing. The Anthropic adapter retries on the API's fallback model for refusals. |
| Partial writes | `timeline.json` and `transcript.json` are written to `.tmp` and renamed. |
| Voice disconnect | The recorder waits up to 5 s to reconnect before giving up. Clips already written are kept. |
| Several GMs online | Only the active GM's module handles WebSocket events. |
| Disk growth | Audio retention (`AUDIO_RETENTION_DAYS`) is checked at startup and every 6 hours. The dashboard warns below 1 GB free. |

## 12. Configuration

All configuration lives in `.env` at the repo root (see `.env.example`), is validated by Zod in `bot/src/config.ts`, and is read by the worker in `worker/scribworker/config.py`.

| Group | Variables |
|---|---|
| Discord | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` |
| Storage | `DATA_DIR`, `CAMPAIGN_DIR` |
| API | `API_HOST`, `API_PORT`, `API_TOKEN`, `FOUNDRY_ORIGINS` |
| Worker | `WORKER_URL`, `STT_LANGUAGE`, `WHISTLE_WEIGHTS` |
| LLM | `LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `SUMMARY_CHUNK_MINUTES` |
| Retention | `DELETE_AUDIO_AFTER_TRANSCRIBE`, `AUDIO_RETENTION_DAYS` |

## 13. Testing

| Suite | Command | Covers |
|---|---|---|
| Bot | `cd bot && npm test` | API auth, roster, chat log, status and warnings, participant resolution, pipeline with a fake provider, chunking, quote verification, Foundry journal page building (`journal.test.js`) |
| Bot types | `cd bot && npm run typecheck` | Strict TypeScript across `src/`, `scripts/` and `test/` |
| Worker | `cd worker && .venv\Scripts\python -m pytest` | Clip-to-line conversion and labels, noise filtering, pause splitting, cache resume, live clip then delete, 48 to 16 kHz resampling, path confinement in the API |
| End to end without Discord | `npx tsx scripts/transcribe-dir.ts <dir>`, then `npm run summarize -- <id>` | Real Whistle and a real LLM on a recorded session folder (`data/sessions/fixture-tts` is a TTS fixture) |

## 14. Known limitations and open questions

- **Chat log upload races transcription.** The pipeline starts as soon as `/scrib stop` emits `session.stopped`, and doesn't wait for the module's `POST /chatlog`. Live transcription makes the transcribe step short, so a slow Foundry upload could arrive after summarization has read the folder. Consider waiting a few seconds for the chat log when a module is connected.
- **One transcriber thread.** Whistle isn't thread-safe, so the worker processes one clip at a time. That is plenty for a single table, but several simultaneous guilds would queue.
- **No re-transcription after deletion.** With the default live deletion, adding glossary names later can't improve an old transcript. Only the summary can be redone.
- **Single machine.** The bot, worker and data directory are assumed to share a filesystem: the worker receives local paths, not audio bytes.
- **Languages.** Whistle covers seven European languages. Other languages need a different STT backend behind the same worker API.
- **One recording per guild.** Recordings are keyed by guild ID.
