# ScribBot engineering assessment (2026-10-31)

Written after the live session on 2026-10-31 (session #12: 55 minutes, 5 speakers, Whisper large-v3 on an RTX 5080). It covers transcription throughput, whether CPU offloading helps, and stability. **Nothing was changed** to produce it; all evidence comes from read-only inspection of the code, the session folder, the worker's `/health`, the bot's `/status` and system counters.

| Document | What it covers |
|---|---|
| [01-performance-and-cpu-offload.md](01-performance-and-cpu-offload.md) | Why transcription fell 5–6× behind real time, what the CPU can and cannot do, and the ranked fixes |
| [02-stability.md](02-stability.md) | Crash paths, data-loss paths and operational gaps, ranked by severity |
| [03-incident-2026-10-31.md](03-incident-2026-10-31.md) | What happened tonight: the backlog and the bot exiting mid-session |
| [04-adr-rust-rewrite.md](04-adr-rust-rewrite.md) | Decision record: rewrite the core in Rust? (Not now; fix the measured causes first, and revisit on stated triggers) |
| [05-cleanup-dashboard-and-monitor.md](05-cleanup-dashboard-and-monitor.md) | Clean-up actions: merge the duplicate dashboard (7420) and monitor (7422) into one page, slim the monitor to a crash watchdog, and fix the confusing "failed" and `/scrib process` behavior seen on 2026-10-31 |

## Executive summary

**1. Transcription is slow because most of the GPU's work is wasted, not because the GPU is too small.**

| Measured on session #12 | Value |
|---|---|
| Clips arriving | **27.5 / min** (1,510 clips in 54.9 min) |
| Clips converted | **~4–5 / min** |
| Median clip length | **1.15 s** (45% under 1 s, 67% under 2 s) |
| Clips whose every line was discarded as noise afterwards | **54%** (204 of 380) |
| Most common "transcription" | `dragon` (73×), then the literal hotword list `giant slug, glabrezu, golem, greater…` (18×) |
| GPU utilization / power | 63% / 151 W, so it isn't saturated |
| CPU (Ryzen 9 9950X, 16C/32T) | ~10% busy |

Three things compound:
- Whisper always encodes a 30-second window, so a 1-second clip costs as much as a 30-second one: about **14× the compute** of the actual speech.
- Every clip is sent up to 150 hotwords, mostly Foundry monster names (122 actors). On near-silent clips Whisper recites them back. That produces junk text and triggers slow retries (temperature fallback, up to 6 decodes at beam size 5).
- More than half of the clips have no usable speech, yet they go through the full model before being thrown away.

**2. CPU offloading helps, but as a filter and an overflow lane, not as a replacement for the GPU.** The CPU is the right place for voice-activity detection: dropping silent clips before they reach the GPU removes about half the queue. A separate CPU worker process running a smaller int8 model can also absorb short clips. Moving large-v3 itself to the CPU would be slower. See [01 §4](01-performance-and-cpu-offload.md#4-cpu-offloading-what-it-can-and-cant-do).

**3. The bot has at least two ways to crash the whole process, and a crash ends the recording.** No `error` listeners exist on the Discord client or the voice connection. A failed `timeline.json` rename on Windows becomes an unhandled promise rejection. Both terminate Node. Tonight's exit left a `timeline.json.tmp` behind, which points at the second. Nothing restarts the bot, nothing tells the table, and no log file survives. See [02](02-stability.md) and [03](03-incident-2026-10-31.md).

## Recommended order of work

Each phase is small, independently shippable, and measurable with the metrics added in phase 0.

| Phase | Work | Expected effect | Docs | Status (re-checked 2026-10-31, late) |
|---|---|---|---|---|
| **0. Measure** (½ day) | Per-clip timing in the worker (audio s, decode s, kept/dropped) on `/health`, persistent log files for bot and worker | Every later change can be verified, and crashes leave evidence | 01 §6, 02 S9 | ✅ Done: worker metrics; bot and worker log files |
| **1. Stop the crashes** (1 day) | `error` listeners; guard the clip-finalize promise; retry renames on `EPERM`/`EBUSY`; `unhandledRejection` handler; graceful Ctrl+C during recording | Removes the known process-killing paths | 02 S1, S2, S8 | ✅ **Done** (2026-11-01) |
| **2. Stop wasting the GPU** (1–2 days) | Hotwords: party plus glossary only, none for clips under ~1.5 s. CPU VAD gate. Bounded decoding (`beam_size`, temperatures, `max_new_tokens`). Raise the minimum clip length | Expected to remove about half the queue and most hallucinations. Target ≥ 30 clips/min | 01 R1–R4 | ✅ **Done** (R1–R3 in the worker; R4 not needed). Measured ~430 clips/min of capacity, 2% suspect lines |
| **3. Use the hardware** (2–3 days) | Batched GPU inference; `large-v3-turbo`; optional CPU overflow worker | Target ≥ 55 clips/min (2× the arrival rate) | 01 R5–R7 | ⏸ **Not needed.** The target is met without it |
| **4. Survive restarts** (2–3 days) | Supervisor with auto-restart; rebuild the queue from disk; resilient end-of-session polling; rejoin the voice channel and notify the table on loss; merge an interrupted game's two sessions into one transcript | A crash or restart costs seconds of audio, not the rest of the session, and the game still gets one summary | 02 S3–S7, S15 | ✅ **Done**: queue from disk, pause/resume, priorities, bounded decoding, model reload, supervisor loop, resilient polling, rejoin, same-session resume after a restart, and the session merge |
| **5. Clean-up** | Append-only timeline journal; hermetic worker tests; fail fast on bad LLM config. One dashboard instead of two; monitor cut down to a watchdog; clearer "failed" and `/scrib process` behavior; an honest "linked" count, and `/scrib map` links written into Foundry automatically | Less I/O, fewer surprises, one page to watch, no Discord IDs typed by hand | 02 S10–S14, 05 C1–C11 | ✅ Done in code: S10, S11, S13, S14, C1, C2, C4–C7, C10, C11, R9; S12 mitigated. Open: C3 (decide after a few crash-free sessions), C8 and C9 (operational) |

Phases 1 and 2 are the priority before the next session. Phase 2's hotword change alone is a few lines and is likely the largest single gain, but measure it (phase 0) rather than assume it.

**Update (re-checked 2026-10-31, late, during session #13):** phase 2 is done and measured. The worker takes 0.14 s per clip (p95 0.39 s), keeps up live with an empty queue, skips ~51% of clips as silence, and only 2% of lines look hallucinated, down from 18%. Throughput is no longer the problem, so phase 3 is shelved. **Next is phase 1 (crash fixes in the bot)**, then the rest of phase 4. All remaining items except S7's model reload, S5's priorities and [01 R9](01-performance-and-cpu-offload.md#5-recommendations-ranked-by-expected-gain--effort) (drop the "thank you" filler on short, unsure clips; ~4% of lines) are bot changes; do them between sessions.

**Update (2026-11-01):** phases 1, 4 and the code items of phase 5 are implemented: see the status columns above and in [02](02-stability.md), [03](03-incident-2026-10-31.md) and [05](05-cleanup-dashboard-and-monitor.md). They take effect when the bot and worker are next restarted (between sessions), and C11 needs the updated Foundry module. Still to do by hand: set `LLM_MODEL` (05 C9), retire the audio keeper (05 C8), decide on the watchdog after a few crash-free sessions (05 C3), and run the 01 §6 benchmark, which would also check the R9 thresholds.

## Open item from this session

~~The uncommitted monitor change reads `timeline.json` every 3 seconds while the bot is writing it.~~ **Fixed:** the monitor now uses the bot's clip count while a session records, and opens `timeline.json` only once recording has ended. See [02 S11](02-stability.md#s11-medium-the-new-monitor-panel-reads-timelinejson-while-the-bot-writes-it). The monitor now also covers parts of S3, S4, S5, S7 and S9 on the *detection* side: it alerts on a crash mid-recording, missing audio, a stalled worker and a growing backlog, and keeps a copy of the bot's log. The fixes themselves still belong in the bot and worker.
