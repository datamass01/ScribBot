# 05 · Clean-up: one dashboard, a slim watchdog, and loose ends from 2026-10-31

Status (2026-11-01): **C1, C2, C4–C7, C10 and C11 done** in code. C3 waits for a few sessions without a crash. C8 and C9 are operational steps, not code. The bot, worker and Foundry module must be restarted (and the module reinstalled for C11) before the changes apply.

## Problem

There are two pages that show almost the same thing:

| Port | Page | Comes from |
|---|---|---|
| 7420 | The bot's dashboard (`bot/public/dashboard.html`) | The bot's Fastify API |
| 7422 | The monitor (`monitor/scribmonitor.py`) | Re-serves the bot's dashboard and adds a "Transcription pipeline" panel (`monitor/panel.js`) |

This is a leftover of how 2026-10-31 went, not a design choice. The rule that night was "don't change the bot", so the pipeline panel (queue, conversion progress, quality, alerts, safe-to-shut-down) was built into the monitor, which had to copy the whole dashboard to show it. The result is confusing: it isn't obvious which page to watch, and anyone looking at both sees what looks like two copies of the monitor.

Almost everything the monitor adds comes from data the bot already has. The bot polls the worker's `/health`, knows its sessions and recordings, and can read `transcript.partial.jsonl`. Only a few things genuinely need a separate process, because they have to work when the bot is down:

- Noticing that the bot died mid-recording. Tonight's crash at 21:36 is the case this was built for; see [03](03-incident-2026-10-31.md).
- Keeping the bot's log lines on disk so they survive a crash (`data/logs/scribbot-YYYY-MM-DD.log`).
- Answering "is the worker still busy, is it safe to shut down?" when the bot isn't there to ask.

## Decision (proposed)

Make the bot's dashboard the **single page**. Cut the monitor down to a **watchdog** with no page of its own, apart from a small fallback page for when the bot is down.

## Actions

| # | Action | Where | Size | Notes |
|---|---|---|---|---|
| **C1** | ✅ Move the pipeline panel into the bot's dashboard (`bot/src/api/pipeline.ts`, `/status` → `pipeline`) | `bot/src/api/status.ts`, `bot/public/dashboard.html` | ½–1 day | Add a `pipeline` block to `/status` covering queue depth, rate and trend, ETA, per-session conversion with quality, alerts and shutdown advice. Port the logic from `Monitor.pipeline()` and its tests (`monitor/test_scribmonitor.py`). Keep the rule never to open `timeline.json` while recording (02 S11). Use the bot's own Zod types, and run `npm run schemas` if `/status` gains a contract. |
| **C2** | ✅ Slim the monitor to a watchdog (`/` redirects to 7420 while the bot is up; `monitor/offline.html` while it's down; `panel.js`/`panel.css` removed) | `monitor/scribmonitor.py` | ½ day | Keep crash detection, the log copy and the worker-queue check. Drop the dashboard re-serve, the HTML injection and `panel.js`/`panel.css`. When the bot is up, 7422 redirects to 7420. When the bot is down, it serves a small static page: crash notice, last log lines, worker queue, safe/wait. |
| **C3** | Decide whether the watchdog stays at all | — | — | If 02 S1 (the `timeline.json` rename crash) and S2/S8 (missing `error` listeners, unhandled rejections) are fixed and a supervisor restarts the bot (02 S3), the watchdog's crash role mostly goes away. Then delete `monitor/` and `start-monitor.ps1`, and move the log copy into the bot as a rotating log file (02 S9). |
| **C4** | ✅ Don't mark a session failed just because the worker restarted (polling retries and resubmits; see 02 S6) | `bot/src/pipeline.ts` | ½ day | Tonight's worker restart made the bot report "Processing failed: worker unreachable" for #12, even though the new worker re-queued and finished all 1,513 clips from disk by itself. Instead, retry `/health` for a while, and continue once the worker comes back with `recovered`. At minimum, say in the Discord message that the clips are kept and `/scrib process session:N` will finish them. |
| **C5** | ✅ `/scrib process` with no session should skip one that's recording (`defaultSessionToProcess()`) | `bot/src/commands.ts` (`process`) | 1 hour | Today it picks the latest session. During a recording that's the live one, and the command fails with "That session is still recording." Default to the latest session that isn't recording, preferring a failed one, and name the session number in the reply. |
| **C6** | ✅ Name the session number in failure messages | `bot/src/pipeline.ts` | 1 hour | "Processing failed" doesn't say which session. Include the `/scrib process session:N` to run. |
| **C7** | ✅ Fold in the one-off fixes from tonight | `monitor/` | done | Already done in the monitor: a failed session the worker is recovering is listed with the exact `/scrib process session:N`, and the monitor now refuses to start a second copy on a port in use. On Windows, `SO_REUSEADDR` had let two monitors share 7422 silently. Carry both into C1/C2. |
| **C8** | Retire the temporary audio keeper | scratchpad `keep_audio.py`, `data/test-audio/` | 10 min | Started on 2026-10-31 to hard-link WAVs while the running bot still had `DELETE_AUDIO_AFTER_TRANSCRIBE=true`. Once the bot has restarted with `false` (now set in `.env`), stop the keeper with `New-Item data\test-audio\STOP`. Keep `data/test-audio/` as the test corpus; it's git-ignored and real voices, so it must never be committed. |
| **C9** | Set `LLM_MODEL` or switch provider | `.env` | 5 min | `LLM_PROVIDER=openai-compatible` with an empty `LLM_MODEL` means every summary fails. Both dashboards warn about it. |
| **C10** | ✅ Make the dashboard's "linked" count include `/scrib map` (`foundry.speakers`; the flag count is shown separately as "Discord IDs in Foundry") | `bot/src/api/status.ts`, `bot/public/dashboard.html` | 1 hour | `foundry.rosterLinked` counts only Foundry users with the module's "Discord ID" flag set. On 2026-10-31 it read **0** while all five speakers were correctly mapped with `/scrib map`, which looks like "nobody is mapped". Report how many recent speakers resolve to a character or the GM by any route (`resolveParticipant` in `bot/src/participants.ts`), and show the Foundry-flag count separately with a clear label. |
| **C11** | ✅ Write `/scrib map` links into Foundry automatically (`roster.link`; needs the updated module installed) | `bot/src/events.ts`, `bot/src/commands.ts`, `bot/src/api/server.ts`, `foundry-module/scripts/main.js` | ½ day | Nobody should have to type Discord IDs into Foundry. When `/scrib map` is picked from the autocomplete list, the bot already stores the Foundry user ID next to the Discord ID (all four player mappings on 2026-10-31 have one). See below. |

### C11: write `/scrib map` links into Foundry

Today the bot can link a Discord user to a character in two ways: `/scrib map` in Discord (checked first), or a "Discord ID" set by hand on each Foundry user in the module's settings. The bot already knows everything the second way needs, so it can fill it in itself:

1. **New WebSocket event** `roster.link` with `[{ foundryUserId, discordId }]`, built from the `mappings` rows that have a `foundry_user_id`. Add it to `BotEvent` in `bot/src/events.ts` and to the `/ws` list in `docs/design.md`.
2. **When the bot sends it:**
   - after a `/scrib map` or `/scrib unmap` that touches a Foundry user;
   - after each `POST /roster`, for any mapped Foundry user whose reported `discordId` is missing or different. This covers a Foundry that was offline when the map was made.
3. **What the module does:** the active GM's client (journals and the combat log already work this way, relayed over the module socket when the bridge is a player) calls `user.setFlag("scribbot-bridge", "discordId", id)` for each entry, then re-syncs the roster. Players can't edit other users, so this must stay GM-only. Works the same on Foundry v12 and v13.
4. **Rules:**
   - `/scrib map` wins, matching the precedence the bot already uses, so a flag that differs is overwritten. Log it on both sides.
   - `/scrib unmap` clears the flag only if it still holds that Discord ID.
   - The GM mapping (`/scrib gm`) has no Foundry user, so it isn't written. If the world has exactly one GM user, link that one; otherwise leave it.
   - Don't guess from names. Discord and Foundry names don't line up reliably (on 2026-10-31: a Discord name built from a character's name vs a short Foundry user name, and a character-style Discord name vs a player's first name). Matching by name could at most be offered as a suggestion in the dashboard, never written automatically.

**No remapping after the upgrade.** Existing mappings must fill in by themselves: the first `POST /roster` after the bot and module are updated finds every mapped Foundry user with no flag and sends `roster.link` for them. Only mappings typed as a free-text name (no `foundry_user_id`) can't be written, and need one `/scrib map` picked from the list. The upgrade needs the new module installed in Foundry, and a GM online for the first write; until then the bot retries on each roster sync.

**Why bother when `/scrib map` already works:** the link then also lives in the Foundry world. It survives losing or resetting `data/scribbot.db`, works in another Discord server, and makes C10's count honest.

**Test:** a `/scrib map` to a roster user emits `roster.link` with the right IDs; a roster post with a stale flag triggers a corrective `roster.link`; `/scrib unmap` clears only a matching flag. Cover the module side alongside `foundry-module/scripts/journal.js` in the vitest suite.

## Order

1. C5 and C6: small bot changes that fix the confusing messages.
2. C1: one page.
3. C2: the slim watchdog. Re-check C3 after the phase 1 crash fixes in the [README](README.md#recommended-order-of-work) have run for a few sessions without a crash.
4. C4: together with phase 4 ("Survive restarts").

C8 and C9 can be done any time after the next bot restart. C10 and C11 can go in with C1, since they touch the same `/status` block and dashboard.

## Done when

- One URL (`http://127.0.0.1:7420`) shows recording, worker, pipeline, alerts and safe-to-shut-down.
- With the bot stopped, either `http://127.0.0.1:7422` shows the crash notice and worker queue, or (after C3) the bot's own supervisor and log file make that unnecessary.
- A worker restart mid-session doesn't produce a "failed" session that the user has to diagnose.
- README and `docs/design.md` describe the one dashboard, and the watchdog only if it remains.
