# 04. ADR: Rewrite the core components in Rust?

| | |
|---|---|
| **Status** | Decided: **not now** (revisit after the triggers in §6) |
| **Date** | 2026-10-31 |
| **Scope** | Transcription worker (`worker/`), bot and recorder (`bot/`), summarizer (`bot/src/summarize/`) |
| **Related** | [01 performance](01-performance-and-cpu-offload.md), [02 stability](02-stability.md), [03 incident](03-incident-2026-10-31.md) |

## 1. Context

Session #12 exposed two problems: transcription ran 5–6× slower than speech arrived, and the bot exited mid-recording. The question is whether moving the core AI, transcription and audio conversion components to Rust would improve performance and stability.

What we know from the assessment:
- **Where the time goes.** The worker is a thin Python layer over faster-whisper, which runs the model in CTranslate2 (C++/CUDA). The measured waste is in how the work is set up, not in the language:
  - Sub-second clips are padded to a 30-second window: about 14× the necessary encoder work.
  - About 130 hotwords per clip cause hallucinated output and slow retries.
  - 54% of clips yield nothing usable but are fully processed.
  - Clips are processed one at a time, so the GPU runs at 63%.
- **Why the bot exited (probable).** An unhandled promise rejection from a failed `timeline.json` rename on Windows. Contributing factors are no `error` listeners on the Discord client or voice connection, no supervisor, no persistent logs, and no recording resume.

## 2. Options

| | Option | Summary |
|---|---|---|
| A | **Full rewrite in Rust** | Bot (serenity/songbird), worker (whisper-rs / CTranslate2 bindings / candle), summarizer (reqwest) |
| B | **Rewrite only the worker** in Rust, behind the same HTTP API | Bot stays TypeScript; Foundry module unchanged |
| C | **Keep the stack, fix the causes** | Assessment phases 0–3, plus lint and type-checking rules that give Rust-like error discipline |

## 3. Evaluation

### Performance

| Factor | Rust (A/B) | Current stack (C) |
|---|---|---|
| Model execution (encoder/decoder on GPU) | Same class of native engine; no inherent speedup | Already native (CTranslate2) |
| 30-s padding, hotword hallucinations, junk clips, serial processing | Must be fixed the same way, in Rust | Fixed in Python, in days ([01 R1–R6](01-performance-and-cpu-offload.md#5-recommendations-ranked-by-expected-gain--effort)) |
| Python overhead between GPU calls | Removed | Small; mostly hidden once clips are batched |
| Ready-made features: Silero VAD, batched pipeline, hotwords, word timestamps, temperature fallback control | Partly missing or less mature; rebuild needed | Available in the installed faster-whisper 1.2.1 |
| CPU overflow lane | Possible | Possible (separate worker process) |

**Conclusion:** the measured slowdown would survive a rewrite unchanged. The gain specific to Rust (removing interpreter overhead) is small next to the wasted work, and isn't measurable until that waste is gone.

### Stability

| Failure mode ([02](02-stability.md)) | Does Rust prevent it? | Fix in the current stack |
|---|---|---|
| S1: unhandled rejection from a failed rename | **Partly.** `Result` forces the error to be handled, but Windows still refuses the rename while the file is open, so retry logic is still needed | try/catch, retry on `EPERM`/`EBUSY`, `unhandledRejection` handler, `no-floating-promises` lint rule |
| S2: `error` events without listeners | **Mostly.** No implicit throwing emitters | Add the listeners (a few lines) |
| S3/S4: crash ends the recording; lost voice connection not handled | No: a design gap | Supervisor, resume recording, rejoin and notify |
| S5/S6: in-memory queue; fragile end-of-session polling | No: a design gap | Rebuild the queue from disk; retry and resubmit |
| S7: no CUDA recovery or watchdog | No | Failure counter, model reload, exit for the supervisor |
| S9: no persistent logs | No | Log files (the monitor already keeps a copy of the bot's log) |

**Conclusion:** Rust's compiler would have forced attention to S1 and S2, which is a real benefit. The same discipline can be had cheaply with lint and type-checker rules. Most stability work is about design and operations, and is the same in any language.

### Risk and cost

- **Discord voice receive is the critical dependency.** `@discordjs/voice` is the most widely used and maintained library for receiving voice, including Discord's newer end-to-end voice encryption (the bot uses `@snazzah/davey`). Songbird's receive support is less mature. Whether it supports that encryption **has not been verified**, and it would block option A if it doesn't.
- **Effort.** Option A is weeks of work: the bot, recorder, pipeline, API, dashboard backend, worker, the two test suites, and Windows packaging. Option B is 1–2 weeks for the worker alone. Option C is days.
- **Regression risk.** Audio is deleted after transcription by default, so a transcription regression in a rewrite permanently damages live sessions.
- **Team fit.** The project's conventions, tests and tooling (Zod as the source of truth, Pydantic mirrors, vitest, pytest, tsx) are built around TypeScript and Python.

## 4. Decision

**Option C. Keep TypeScript (bot) and Python (worker), and fix the measured causes.**

1. Assessment phases 0–3: measure, stop the crashes, stop wasting the GPU, batch.
2. Get the main benefit of Rust's error handling without a rewrite:
   - **Bot:** enable `@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-misused-promises` as errors; add `unhandledRejection`/`uncaughtException` handlers; add `error` listeners on every emitter we own or subscribe to.
   - **Worker:** run `pyright` or `mypy --strict` over `scribworker/`, and run it under a supervisor.
3. Keep the worker behind its HTTP API (`/health`, `/clips/transcribe`, `/jobs/*`), so a later engine or language change stays contained.

## 5. Consequences

- **Positive:** the fixes that matter ship in days, with low risk, and are verifiable by the benchmark in [01 §6](01-performance-and-cpu-offload.md#6-measuring-it-do-this-first). The Discord voice stack stays on the best-supported library.
- **Negative:** errors are still not checked by the compiler, so discipline depends on lint rules and code review. Running Python and Node side by side remains, along with two runtimes to install.
- **Neutral:** option B stays open, because the worker's HTTP API is the boundary.

## 6. When to revisit

Reopen this decision (most likely as option B, the worker only) if any of these become true:

1. **After phases 0–3,** profiling shows the GPU waiting on Python: low GPU utilization with batching on, and a significant share of time per clip in Python rather than in CTranslate2.
2. **Distribution matters:** the worker should ship as a single executable with no Python install, e.g. for other tables to install.
3. **Memory or latency limits** on smaller hosts, where a Python runtime alongside the model is the binding constraint.
4. **A Rust Discord voice stack** is verified to support voice receive and Discord's end-to-end voice encryption, with an active maintainer. This is only relevant to option A.

**Check (2026-10-31, late):** none of the triggers has fired. Fixing the measured causes in the Python worker took it from 12–15 s to 0.14 s per clip, about 100× faster. The GPU now sits idle between clips because no work is waiting, not because Python is slow. That confirms the decision.

If reopened, start with a prototype: a Rust worker exposing the same `/health` and `/clips/transcribe` API, run on the benchmark clip set from [01 §6](01-performance-and-cpu-offload.md#6-measuring-it-do-this-first) and compared against the tuned Python worker. Proceed only if it is clearly faster at equal accuracy.
