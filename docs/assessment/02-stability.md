# 02. Stability and reliability review

Scope: `bot/` (Discord, recorder, pipeline, worker client), `worker/` (queue, model thread) and how they're run on Windows. Findings are ranked by **impact × likelihood**. Each finding has evidence (file and line), the failure it causes, and a proposed fix. Nothing has been changed.

**Severity:** **Critical**: kills the bot or loses the rest of a session, and is likely. **High**: loses work or needs manual recovery. **Medium**: degrades or complicates recovery. **Low**: hygiene.

## Summary

| # | Severity | Finding | Consequence | Status (re-checked 2026-10-31, late) |
|---|---|---|---|---|
| S1 | Critical | Clip finalization can reject unhandled (Windows rename failure) | Node exits mid-recording | ✅ Done (2026-11-01) |
| S2 | Critical | No `error` listeners on the Discord client or voice connection | Node exits on any gateway or voice network error | ✅ Done |
| S3 | High | A bot exit ends the recording for good, and nothing restarts the bot or tells the table | Rest of the session is not recorded | ✅ Done: supervised restart, same-session resume, Discord notice |
| S4 | High | Lost voice connection is only logged; the session keeps "recording" nothing | Silent loss of audio | ✅ Done: rejoin with backoff, notices, `/status` state |
| S5 | High | Worker queue is in memory and unbounded | Worker restart drops the backlog; no backpressure | ✅ Done: queue from disk, pause/resume, priorities, Discord backlog warning |
| S6 | High | End-of-session polling fails the session on one transient error | Sessions fail needlessly; manual `/scrib process` | ✅ Done: retries, resubmit on 404, deadline |
| S7 | Medium | One transcription thread, no per-clip time limit, no CUDA recovery | One bad clip or GPU fault stalls or poisons everything | ✅ Done: bounded decoding, model reload (exit if it fails), slow-clip log |
| S8 | Medium | Ctrl+C during a recording doesn't finalize it | Timeline left open; session marked failed | ✅ Done |
| S9 | Medium | No persistent logs; crash reason not recorded | Tonight's exit can't be diagnosed with certainty | ✅ Done: daily bot and worker log files, exit reason |
| S10 | Medium | `timeline.json` is rewritten in full for every clip | Quadratic I/O; amplifies S1 | ✅ Done: segment journal + 30 s snapshots |
| S11 | Medium | The new monitor panel reads `timeline.json` while the bot writes it | Raises S1 likelihood | ✅ **Fixed** (monitor, and the worker's recovery never opens it) |
| S12 | Low | Audio deleted even when the transcription is junk | Bad clips can never be redone | ✅ **Mitigated.** `DELETE_AUDIO_AFTER_TRANSCRIBE=false` in `.env` (the bot applies it on restart); `data/test-audio/` keeps tonight's WAVs |
| S13 | Low | Worker tests read the real `.env` | A test fails on this machine (`STT_ENGINE=whisper`) | ✅ **Fixed.** The test sets `STT_ENGINE` with `monkeypatch` |
| S14 | Low | `LLM_PROVIDER=openai-compatible` with empty `LLM_MODEL` isn't flagged until a summary runs | Failure discovered late (session #7) | ✅ Done in code: `/status` warns regardless, `/scrib summarize` checks first. `LLM_MODEL` is still empty in `.env` (05 C9) |
| S15 | High | An interrupted game ends up as two sessions with no way to merge them | Two transcripts, two summaries and two journals for one game; the LLM can't reason across the break | ✅ Done (`npm run merge`, `/scrib merge`) |

**Status (2026-11-01):** every item is implemented; S12 stays mitigated by configuration. What's left is operational: restart the bot and worker between sessions so the changes take effect, set `LLM_MODEL` (05 C9), and, if wanted, install the supervisor as a Windows service (S3).

---

### S1 (Critical). Clip finalization can reject unhandled

**Where:** `bot/src/recorder.ts:127-153` and `writeTimeline()` at `:169-185`.

The per-clip promise chain is `pipeline(...).catch(...).then(() => { ...; this.writeTimeline(null); this.onSegment(...) }).finally(...)`. Only the stream is guarded. Anything that throws inside `.then` (`fs.rmSync`, `writeTimeline`, `onSegment`) rejects `job`. Nothing awaits `job` except `stop()`'s `allSettled`, so the rejection is **unhandled**. Node 22+ (24.22 here) terminates the process on an unhandled rejection by default, and `index.ts` installs no `unhandledRejection` handler.

The likeliest throw is `fs.renameSync(tmp, timeline)`. On Windows, renaming over a file fails with `EPERM`/`EBUSY` while another process has it open without `FILE_SHARE_DELETE`. Typical culprits are Windows Defender scanning the just-written file, the search indexer, an editor or preview pane, or any Python reader (Python opens files without that share flag). This is a well-known Node-on-Windows problem; `graceful-fs` retries such renames for up to a minute for exactly this reason. It happens once per clip (1,510 times tonight), so even a rare collision becomes likely over a long session.

**Evidence tonight:** the bot exited at 21:36 local, mid-recording, leaving `timeline.json.tmp` next to `timeline.json`, both stamped 21:36:37. A leftover `.tmp` means the process wrote the temp file and never completed the rename. See [03](03-incident-2026-10-31.md).

**Fix:**
1. Wrap the body of the `.then` in `try/catch` and log with `[recorder]`; a failed timeline write must never end the process.
2. Retry the rename on `EPERM`/`EBUSY`/`EACCES` with a short backoff (e.g. 10 attempts, 20 → 500 ms), as `graceful-fs` does. Apply the same to every atomic-write helper (`.tmp` + rename) in the bot.
3. Add `process.on("unhandledRejection")` and `process.on("uncaughtException")` handlers. Log with stack. For rejections, keep running. For uncaught exceptions, stop active recordings cleanly (S8) and then exit non-zero so the supervisor (S3) restarts.
4. Reduce the number of renames (S10).

**Status: done.** `bot/src/fsutil.ts` retries renames on `EPERM`/`EBUSY`/`EACCES` (10 tries, 20 → 500 ms) for every atomic write; the clip callback (`finishClip`) catches and logs everything, and its promise chain ends in a `.catch`; `index.ts` logs `unhandledRejection` and keeps running, and on `uncaughtException` stops recordings cleanly and exits 1. Tests: `bot/test/resilience.test.ts` (rename retried twice then succeeds; rename always failing → clip still handed on, `stop()` still returns).

### S2 (Critical). No `error` listeners on the Discord client or voice connection

**Where:** `bot/src/index.ts` (no `client.on(Events.Error)`, no `ShardError`); `bot/src/recorder.ts:55-81` (no `connection.on("error")`).

Both are `EventEmitter`s. An `error` event with no listener is thrown as an uncaught exception, which ends the process. `@discordjs/voice` emits `error` on UDP/WebSocket failures (IP discovery, socket resets, encryption negotiation). discord.js emits `error` on WebSocket faults. On a home connection over a 1–4 hour session, at least one is likely to happen eventually.

**Fix:** add listeners that log (`[discord]`, `[recorder]`) and let the existing reconnection logic work: `client.on(Events.Error)`, `client.on(Events.ShardError)`, `client.on(Events.Warn)`, `connection.on("error")`, plus `connection.on("stateChange")` at debug level.

**Status: done**, plus `ShardDisconnect`/`ShardReconnecting` logging. `stateChange` is logged with `SCRIBBOT_DEBUG_VOICE`.

### S3 (High). A bot exit ends the recording for good

**Where:** `bot/src/index.ts:14-19` marks any `recording` session `failed` on startup. Recording state lives only in the process.

Even if the bot were restarted immediately, nobody rejoins the channel, so the rest of the session is lost. Also: nothing restarts it (the bot runs in an interactive console from `start.ps1`, where closing the window or a stray Ctrl+C ends it); nothing tells the table; and the dashboard goes dark.

**Fix:**
1. **Supervisor.** Run worker and bot under something that restarts on non-zero exit and writes logs: NSSM or WinSW as Windows services, or a Task Scheduler task with restart-on-failure, or `pm2`. Make `start.ps1` optionally install it.
2. **Resume recording after a restart.** Persist "recording in channel X since T" in the database. On startup, for a session that was `recording` less than N minutes ago, rejoin the channel and continue in a new segment set, with an offset so the timeline stays continuous. Or start a linked continuation session and merge the two at `/scrib stop`. The merge itself is [S15](#s15-high-an-interrupted-game-ends-up-as-two-sessions-with-no-way-to-merge-them). Post "⚠️ ScribBot restarted; recording resumed (gap 00:00:12)" in the text channel.
3. When resume isn't possible, post a Discord message right away, not just a database status.

**Status: done.** 1: `start.ps1` and `start-worker.ps1` run a restart loop (non-zero exit → restart after 5 s, give up after 5 restarts in 10 min, `-NoRestart` to disable); installing it as a Windows service is left to the operator. 2: the bot resumes the **same session** rather than a linked one: a session still `recording` whose timeline changed less than `RESUME_WINDOW_MINUTES` (30) ago is rejoined on the same clock (`bot/src/recovery.ts`, `CommandHandler.resumeInterrupted`), with the gap posted in Discord. No merge is needed, so S15's step 3 is moot. 3: sessions that can't be resumed are failed and announced in their text channel. The transcript doesn't mark the gap (design §14).

### S4 (High). Lost voice connection is only logged

**Where:** `bot/src/recorder.ts:70-81`. On `Disconnected`, if it doesn't recover within 5 s, the recorder logs `lost voice connection` and destroys the connection. The session stays `recording`, the dashboard still shows it as live, and nothing is recorded until someone notices.

**Fix:** on unrecoverable disconnect, try to rejoin with backoff (the channel ID is known). If that fails, notify the text channel and mark the session degraded (a new status, or a warning in `/status`), so the monitor turns red.

**Status: done.** The recorder closes open clips and rejoins after 2, 5, 10, 20, 30 s, then every minute until `/scrib stop`. Discord gets a message on loss, on recovery (with the gap) and after 5 failed tries. `/status` carries `connection` per recording and a warning while it isn't `connected`; the dashboard shows it on the recording card.

### S5 (High). Worker queue is in memory and unbounded

**Where:** `worker/scribworker/server.py:73` (`queue.Queue()`), `:177-184` (live clips), `:158-175` (jobs, also in memory: `jobs` dict).

- A worker restart drops every queued clip and every job ID. The WAVs remain, so `/scrib process` can redo them, but no state shows what was pending.
- No bound or backpressure: tonight the queue reached 1,200+ with no warning in Discord.
- FIFO: the end-of-session job waits behind every live clip, and a `/scrib process` for an old session waits behind the live session.

**Fix:**
1. **Derive pending work from disk** rather than memory: pending = clips in `timeline.json` minus entries in `transcript.partial.jsonl`. On worker start (and periodically), re-enqueue pending clips for sessions still active. Transcription is already idempotent per clip, so this is safe.
2. **Priorities:** live clips of the current session > end-of-session jobs > reprocessing old sessions.
3. **Backpressure and visibility:** expose `queued`, the rate and the ETA (as the monitor now computes) from the worker itself. Have the bot warn in Discord once when the ETA exceeds a threshold (e.g. "transcription is ~40 min behind").

**Status: partly done (worker).**
- Fix 1 is ✅ done. On start, `unfinished_clips()` re-queues WAVs that have no entry in `transcript.partial.jsonl`, for sessions without `transcript.json` modified in the last `recover_hours`. It reads only the folders and the cache, never `timeline.json`. Tonight it recovered 2 sessions and 2,660 clips, and #12 finished from disk.
- `POST /pause` and `POST /resume` were added.
- Fix 3 is partly done: `/health` reports `queued`, `paused`, `recovered` and `stats.clipsPerMin`, and the monitor computes the ETA.
- ~~Still open: priorities (fix 2) and the Discord backlog warning.~~ **Done (2026-11-01):** a priority queue (live clips, then the end-of-session job of a recently live session and recovered clips, then the rest; test `test_live_clips_run_before_a_job_for_an_old_session`), and the bot posts once per recording when the backlog exceeds `BACKLOG_WARN_MINUTES` (10). The queue still lives in memory, but losing it no longer loses work.

### S6 (High). End-of-session polling fails the session on one transient error

**Where:** `bot/src/worker-client.ts:47-66`. The poll loop calls `GET /jobs/{id}` every second with no retry. One refused connection or timeout throws, and the whole session goes to `failed`. If the worker restarted, the job ID is unknown (404), which also fails. There's no overall deadline either, so a hung job polls forever.

**Fix:** retry polls with backoff for a bounded time (e.g. 5 minutes); on 404, resubmit `POST /jobs/transcribe`, which is idempotent thanks to the clip cache. Add a deadline proportional to clip count. Report "waiting for worker" progress instead of failing.

**Status: done** (`bot/src/worker-client.ts`): backoff 1, 2, 5, 10, 15, 30 s for up to 5 minutes of consecutive failures; 404 → resubmit; deadline 10 min + 5 s per clip; one "waiting for the worker" message in Discord. A real refusal (4xx on submit) still fails at once.

### S7 (Medium). One transcription thread, no per-clip time limit, no CUDA recovery

**Where:** `worker/scribworker/server.py:117-120`.

The single-thread design is required (CLAUDE.md: the model isn't thread-safe) and should stay. But:
- A pathological decode (the hallucination loops in [01 F2](01-performance-and-cpu-offload.md#f2-the-hotword-list-is-being-transcribed-instead-of-the-speech)) has no upper bound and blocks the queue.
- After a CUDA fault (driver reset, out of memory), every subsequent clip fails. `liveClips.failed` rises, but the worker never reloads the model or exits.

**Fix:** bound decoding ([01 R3](01-performance-and-cpu-offload.md#5-recommendations-ranked-by-expected-gain--effort)). Count consecutive failures, and after N, drop and reload the model, then exit non-zero if that fails, so the supervisor restarts the process. Add a watchdog: if one task runs longer than M seconds, log the clip path so the culprit is known.

**Status: done.** Bounded decoding: three temperatures, `max_new_tokens` tied to clip length, p95 0.39 s. Model errors in a row (not file errors) are counted; after `WORKER_RELOAD_AFTER_FAILURES` (5) the transcription thread reloads the model, and exits with code 3 if that fails, so the supervisor restarts it. A watchdog thread logs a clip running longer than `WORKER_SLOW_CLIP_SECONDS` (60); `/health` shows `current`, `consecutiveFailures` and `modelReloads`.

### S8 (Medium). Ctrl+C during a recording doesn't finalize it

**Where:** `bot/src/index.ts:53-58`. `shutdown` destroys the client and exits; active recorders are not stopped, so the open WAV writers aren't closed (their headers may be missing the length) and `timeline.json` has `endedAt: null`. On the next start the session becomes `failed`.

**Fix:** on SIGINT/SIGTERM, call `recorder.stop()` for every active recording (bounded, e.g. 10 s), mark the session as stopped by shutdown, and leave the pipeline to run on next start or via `/scrib process`. Print "recording N stopped and saved" before exiting.

**Status: done** (`CommandHandler.stopAll`), also on SIGBREAK (closing the console). The table is told, and the pipeline runs automatically on the next start.

### S9 (Medium). No persistent logs

**Where:** `bot/src/monitor.ts` keeps an in-memory ring buffer; the worker logs to its console window.

When the bot exited tonight, its console output was the only record, and it's gone. The root cause can only be inferred (S1).

**Fix:** write rotating log files: `data/logs/bot-YYYY-MM-DD.log` and `worker-…log`, a few MB each, kept 14 days, and git-ignored like the rest of `data/`. Log the exit code and reason from a `process.on("exit")` hook. Have the monitor show the last lines of the log file when the bot is down.

**Status: done.** The bot writes `data/logs/bot-YYYY-MM-DD.log` (`bot/src/logfile.ts`) and its exit code and reason from a `process.on("exit")` hook; the worker writes `worker-YYYY-MM-DD.log` (`scribworker/logfile.py`). Both roll over at 20 MB and keep `LOG_RETENTION_DAYS` (14). The watchdog's `scribbot-*.log` copy remains while it does (05 C3). Node's own fatal-error output still goes to stderr only.

### S10 (Medium). `timeline.json` is rewritten in full for every clip

**Where:** `bot/src/recorder.ts:148` calls `writeTimeline()` after each clip (and on each new participant).

The file grows with the session, so the cost is quadratic. Tonight that was about 1,510 rewrites of up to 240 KB, roughly 180 MB. A 4-hour session would be around 6,000 rewrites of up to ~1 MB, roughly 3 GB, and 6,000 chances to hit S1.

**Fix:** append each segment to `timeline.segments.jsonl` (append + fsync, no rename). Write the full `timeline.json` snapshot on participant changes, every ~30 s, and at stop. Readers (worker, monitor) merge both. This also keeps the "timeline lists the clip before its audio can be deleted" guarantee, because the append happens before `onSegment`.

**Status: done.** Readers: `readTimeline()` (bot: pipeline, merge, `/status`), `load_timeline()` (worker), `count_segments()` (watchdog). If the journal append fails, the recorder falls back to a snapshot before handing the clip on.

### S11 (Medium). The new monitor panel reads `timeline.json` while the bot writes it

**Where:** the uncommitted change to `monitor/scribmonitor.py` (`conversion()` → `_read_memo(folder / "timeline.json")`).

Every 3 s poll briefly opens `timeline.json` in Python. That widens the window for S1's rename failure. It didn't cause tonight's exit: the monitor running then is the previous version, which only reads the folder while the bot is offline.

**Fix:** while the bot is online, take the clip count from the bot's `/status` (`recordings[].clips`) and don't open `timeline.json`. Read it only when the bot is down. Fixing S1 (rename retry) removes the hazard in general.

**Status: fixed in the monitor.** It no longer opens `timeline.json` for a session the bot is recording (covered by `test_live_recording_never_opens_timeline_json`). S1 itself is still open in the bot.

### S12 (Low). Audio deleted even when the transcription is junk

**Where:** `worker/scribworker/transcribe.py:234-235`. The WAV is deleted after any transcription, including the 54% of clips whose output is later discarded as noise ([01 F3](01-performance-and-cpu-offload.md#f3-more-than-half-of-the-work-is-thrown-away-afterwards)). If a setting such as hotwords caused the junk, those clips can't be redone.

**Fix:** keep WAVs whose result was entirely low-confidence until the session is complete, or for a short retention window, so a `retranscribe` with better settings can recover them.

**Status: mitigated.** `DELETE_AUDIO_AFTER_TRANSCRIBE=false` is set in `.env`, so all WAVs are kept; the running bot applies it on its next restart. Until then, a temporary keeper hard-links tonight's WAVs into `data/test-audio/` (05 C8). Selective retention isn't implemented. With deletion off, it only matters if the default goes back to `true`.

### S13 (Low). Worker tests read the real `.env`

**Where:** `worker/scribworker/config.py:13` calls `load_dotenv()` on import, so the tests inherit this machine's `STT_ENGINE=whisper`. `test_api_runs_job_and_rejects_outside_paths` then expects `ja` to be rejected (Whistle's language list) and gets 200. CLAUDE.md requires hermetic tests.

**Fix:** have the tests set `STT_ENGINE` explicitly with `monkeypatch`, or make `load_settings()` take an environment mapping, as the monitor's `Config.load` does.

**Status: ✅ fixed.** `test_api_runs_job_and_rejects_outside_paths` sets `STT_ENGINE=whistle` with `monkeypatch`.

### S14 (Low). Bad LLM configuration is discovered late

`LLM_PROVIDER=openai-compatible` with an empty `LLM_MODEL` reports `model: null` without a warning while `AUTO_SUMMARIZE=false`, and only fails when `/scrib summarize` runs (session #7). **Fix:** a `/status` warning ("summaries will fail: LLM_MODEL is empty") regardless of auto mode, and a check in `/scrib summarize` before work starts.

**Status: done in code.** `/status` warns about an empty `LLM_MODEL` regardless of auto mode, and `/scrib summarize` runs `llmConfigProblem()` before starting. The configuration itself is still unset (05 C9).

### S15 (High). An interrupted game ends up as two sessions with no way to merge them

**Where:** after a crash, `bot/src/index.ts:14-19` marks the session `failed`, and the next `/scrib start` creates a new session with its own folder, number and clock. `/scrib process` (`bot/src/pipeline.ts`) only resumes one session from its own files, and there's no merge command or script. Until S3's resume exists, every bot exit mid-game produces this split (session #12, 2026-10-31, would have).

**Consequence:** one evening of play becomes two transcripts, two summaries and two Foundry journal entries. The summarizer sees each half alone, so a scene, combat or thread that spans the break is cut in two, and the second summary lacks the context of the first.

**Why a merge is safe:** the formats already line up.
- Transcript lines (`TranscriptLineSchema`) carry speaker, character and text, with `t`/`end` in seconds from their own session's start. Each `timeline.json` records the real `startedAt`, so B's lines shift by `B.startedAt − A.startedAt`.
- The summarizer (`bot/src/summarize/summarize.ts`) reads only `timeline.json` (start time, participants), `transcript.json` and `chatlog.json`, and already chunks long transcripts. A merged transcript is just a longer one.
- Foundry chat and combat timestamps are epoch ms, so they need no shift, only de-duplication by `id`.

**Fix:**
1. **`bot/scripts/merge-sessions.ts`** (`npm run merge -- <A> <B>`), standalone, so it runs without restarting the bot. For target A and continuation B:
   - Back up A's `timeline.json`, `transcript.json`, `transcript.md` and `chatlog.json` (`*.premerge`).
   - Transcript: shift B's lines, append, sort by `t`, and insert a marker line ("— recording resumed after N min gap —") so readers and the LLM know why a scene may break off. Rewrite `transcript.md`.
   - Timeline: union `participants` by `discordId`; set A's `endedAt` to B's; append B's segments with `startMs`/`endMs` shifted, and copy B's WAVs into A's `audio/` under a prefix, so `/scrib process session:A retranscribe:true` reproduces the merge instead of undoing it. Only possible while WAVs are kept (`DELETE_AUDIO_AFTER_TRANSCRIBE=false`); otherwise merge transcripts only and note that re-transcribing A would drop B.
   - Chat log: concatenate `messages` and `combats`, de-duplicated by `id`.
   - Mark B in the database as merged into A (e.g. status `complete`, error text "Merged into session N") so it isn't summarized or listed as failed. Atomic writes (`.tmp` + rename) throughout; refuse if either session is recording or processing.
2. **Then `/scrib merge a:N b:M`** in the bot, sharing the same code, with a summary-only follow-up (`/scrib summarize session:N`). Needs a bot restart, so do it between sessions.
3. **Later, with S3's resume:** a resumed recording continues the same session, so the split doesn't happen at all. S3 already lists "start a linked continuation session and merge the two at `/scrib stop`" as one way to do it; this merge code is that step. Keep the script for manual cases (a restart after the resume window, or a game deliberately recorded in two parts).

Limits: speech while the bot was down was never recorded, and a sentence cut off by the crash stays cut off.

**Status: done (steps 1 and 2).** `bot/src/merge.ts` holds the merge, shared by `bot/scripts/merge-sessions.ts` (`npm run merge -- <A> <B>`) and `/scrib merge a:N b:M` (Manage Server). Differences from the plan: both sessions must be transcribed first; backups are named `*.premerge-<B number>` so a game in three parts can be merged twice; A's `endedAt` falls back to its last clip when the crash left it null; the merged-away session is refused by `processSession`; B's WAVs are copied as `audio/<speaker>/m<B number>-<name>.wav` only if all of them exist. A retranscribe of A keeps B's lines but drops the marker line. Tests: `bot/test/merge.test.ts`. Step 3 isn't needed: S3 resumes the same session instead of starting a linked one, so the merge stays for manual cases.

---

## Operational recommendations

1. **Run as services.** Worker and bot under a supervisor with restart-on-failure and log files (S3, S9). The monitor stays optional.
2. **Pre-session checklist** (could be a `/scrib preflight` command or a monitor panel): worker model loaded on the expected device; queue empty; Foundry connected; speakers mapped; disk free; LLM config valid if summaries are wanted; last session's status.
3. **Don't run development commands against the live data directory during a session.** Scratch scripts, test runs with `DATA_DIR` unset, and editors opening session files all increase S1 risk.
4. **Exclude `data\` from Windows Defender real-time scanning**, or at least the `data\sessions` folder. This reduces S1 collisions, and scanning thousands of small WAVs is wasted work anyway. Weigh this against your own security policy.

## Test plan for the fixes

| Fix | Test |
|---|---|
| S1 | Unit: make `renameSync` throw `EPERM` twice and then succeed. The timeline is written and nothing rejects. Make it always throw: logged, process alive, clip still delivered to `onSegment` |
| S1/S2 | Unit: emit `error` on a fake client/connection; the process survives and logs a `[discord]`/`[recorder]` line |
| S5 | Worker: enqueue clips, restart the app, and confirm pending clips are rediscovered from disk and transcribed exactly once |
| S6 | Worker client: fake worker returns 503, then 404, then done. `transcribe()` resubmits and resolves |
| S8 | Recorder: SIGINT with an open stream leaves a valid WAV header and a timeline with `endedAt` |
| S10 | Recorder: N clips → N appended journal lines, a bounded number of snapshots; readers merge both correctly |
| S15 | Script on two temp sessions (fixture copies with different `startedAt`): merged lines sorted with B shifted by the gap, marker line present, participants unioned, chat de-duplicated, backups written. Running it twice is refused. With audio, `retranscribe` of A yields B's lines too |
| Soak | Replay a recorded session's Opus stream (or the TTS fixture in a loop) for 4 hours against a real worker. No exit, flat memory, queue ETA stays bounded |
