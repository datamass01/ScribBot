# 01. Transcription performance and CPU offloading

> **Status (re-checked 2026-10-31, late):** the target is **met**. The worker changes made during the night (VAD gate, bounded decoding, hotword limits, per-clip metrics) took it from ~4–5 clips/min to keeping up live with session #13.
>
> | Measured live, session #13 (worker `/health`, 5-min window) | Before (session #12) | After |
> |---|---|---|
> | Worker time per clip (mean / p95) | ~12–15 s | **0.14 s / 0.39 s** |
> | Capacity (60 ÷ mean time per clip) | ~4–5 clips/min | **~430 clips/min** (target ≥ 55) |
> | Conversion rate vs. arrival | 4–5 vs. 27.5 /min | equal to arrival (26–36 /min); worker queue **0** |
> | Clips skipped by VAD before the GPU | 0% | **~51%** |
> | Suspect (hallucinated) lines | 18% | **2%** |
> | GPU utilization | 63%, 151 W, always busy | 1–2% average: short bursts, idle between clips |
>
> Per item: **R1** done in the worker, **R2** done, **R3** mostly done, **§6** metrics done (benchmark still to run), **R4–R8** not done and no longer needed for speed. See the Status column in §5. What's left is quality, not throughput: the top remaining repeat is the silence phrase "thank you" (59× in #13, ~4% of lines), tracked as **R9** (open).

## 1. Requirement

Transcription has to keep up with the table while the session is live; otherwise the backlog grows for the whole session and the transcript arrives hours after `/scrib stop`.

- **Arrival rate (measured, session #12):** 1,510 clips in 54.9 minutes = **27.5 clips/min**, with 5 speakers.
- **Minimum:** ≥ 30 clips/min sustained.
- **Target:** ≥ 55 clips/min (2× headroom for busier tables, combat crosstalk and more players). That is ≤ ~1.1 s of worker time per clip on average.
- **Measured tonight:** about 4–5 clips/min. At the end of the night 1,204 clips were queued, about 4.5 hours of work at that rate.

## 2. How a clip flows today

```
Discord Opus ─▶ recorder.ts: one WAV per speech burst (ends after 800 ms silence; < 250 ms dropped)
            ─▶ POST /clips/transcribe (fire-and-forget, one per clip)
            ─▶ worker: in-memory FIFO queue, one thread, one model
            ─▶ faster-whisper large-v3, float16, CUDA
                 beam_size=5 (default), word_timestamps=True, hotwords=<up to 150 names>,
                 temperature fallback 0.0→1.0 (default), no VAD
            ─▶ transcript.partial.jsonl (fsync) ─▶ WAV deleted
            ─▶ is_noise() later discards lines with mean word probability < 0.35
```

## 3. Findings

### F1. Whisper processes 30 seconds for every clip, and the clips are about 1 second long

Whisper's encoder always runs on a 30-second log-mel window; shorter audio is padded. The clip distribution for session #12:

| Clip length | Share |
|---|---|
| < 1 s | 45% (676) |
| < 2 s | 67% (1,017) |
| < 5 s | 91% (1,369) |
| median / mean / p90 | 1.15 s / 2.14 s / 4.8 s |

Total speech was 53.8 minutes, but the encoder processed 1,510 × 30 s = 755 minutes. That is **about 14× the necessary encoder work**. The decoder side scales with output tokens, so it doesn't pad, but see F2.

### F2. The hotword list is being transcribed instead of the speech

`sttKeywords()` (`bot/src/campaign.ts`) sends the party names, the glossary and up to 300 Foundry actor names, capped at 150. With 122 actors synced, almost every clip carries about 130 names, mostly monsters. faster-whisper puts hotwords into the decoder prompt. On a clip with little or no speech, the model continues the prompt instead of transcribing:

| Most frequent cached texts (380 clips so far) | Count |
|---|---|
| `dragon` | 73 |
| `giant slug, glabrezu, golem, greater…` (the hotword list itself) | 18 |
| `the end`, `okay.`, `thank you.`, `thank you for watching!` | classic Whisper silence hallucinations |

51 clips produced more than 6 words per second of audio (e.g. 0.44 s → "And that was the score for this edition of Super Mario Bros."), which is physically impossible.

This costs time as well as quality. Repetitive or low-probability output triggers faster-whisper's **temperature fallback**: re-decoding at temperatures 0.2, 0.4 … 1.0, each at beam size 5, up to the full token budget. A junk clip can easily cost several times a good one. This is the most likely explanation for 12–15 s per clip on an otherwise idle RTX 5080.

### F3. More than half of the work is thrown away afterwards

Of 380 cached clips, **204 (54%) had every line discarded** by `is_noise()` (mean word probability < 0.35, or no alphanumerics). The worker spent full GPU time on them and then deleted their audio. The pipeline knows a clip is junk only after the most expensive step.

### F4. The hardware is under-used

| Resource | Observed during the backlog |
|---|---|
| GPU (RTX 5080, 16 GB) | 63% utilization, 151 W, 6.9 GB used |
| CPU (Ryzen 9 9950X, 16 cores / 32 threads) | ~10% total |
| RAM | 64 GB |

One thread submits one clip at a time, so the GPU idles between kernels (Python, feature extraction, beam search bookkeeping, `fsync`). Nothing runs on the CPU in parallel.

### F5. Smaller contributing factors

- `word_timestamps=True` adds a cross-attention alignment pass to every clip. It's needed to split long clips into lines, but not for clips under ~5 s, which are a single line anyway.
- `beam_size=5` (the default) is a strong setting for long-form audio. For 1–3 s utterances, greedy or beam 2 is usually indistinguishable in quality and markedly cheaper.
- No `max_new_tokens` bound. A 1-second clip is allowed to produce a full 30-second window of text.
- `MIN_SEGMENT_MS = 250` in the recorder lets through many sub-second coughs and clicks; 45% of clips are under 1 s.
- The end-of-session job is queued behind every live clip (FIFO), so `/scrib stop` waits for the entire backlog first. That's correct for completeness, but it explains the long tail.

## 4. CPU offloading: what it can and can't do

**Short answer:** yes, offload to the CPU, but the gain comes from using the CPU to keep junk off the GPU and to process overflow in parallel. Running large-v3 on the CPU would be slower than running it on the 5080.

| Option | What it does | Value | Notes |
|---|---|---|---|
| **A. CPU voice-activity gate** (Silero VAD, as bundled in faster-whisper, or a simple energy/RMS gate) | Rejects clips with no speech before they reach the GPU, and trims silence from the rest | **Highest.** F3 says about half the queue has no usable speech. VAD costs milliseconds per clip on one core | `vad_filter=True` in faster-whisper runs Silero on the CPU. A pre-check before calling `transcribe()` lets an all-silence clip skip the model entirely |
| **B. CPU overflow lane** (second worker *process*, `faster-whisper` int8 on CPU with a smaller model, e.g. `distil-large-v3` or `large-v3-turbo`, or `small.en`) | Takes clips when the GPU queue is deep, or always takes short clips | **Medium.** Adds real capacity from 16 idle cores. Per-clip latency is higher than the GPU, but it runs concurrently | Must be a separate process with its own model: the single-thread rule in CLAUDE.md applies per model instance. The bot (or a dispatcher in the worker) routes clips. Cap threads (e.g. 8) so Discord/Opus decoding on the same machine isn't starved |
| **C. CPU pre-processing** (WAV read, resample, log-mel features) on a separate thread or process, feeding the GPU thread | Keeps the GPU busy while the next clip is prepared | **Low to medium.** Matters once batching (R5) is in place | Clips are already 16 kHz, so resampling is a no-op today |
| **D. Whistle (CPU) for live drafts, Whisper (GPU) for the final pass on demand** | Two-tier transcription | Situational | Whistle is weaker on fantasy names. Only worth it if live text matters more than accuracy |
| **E. Move Whisper large-v3 to the CPU** | – | **Not recommended.** int8 large-v3 on 16 cores is several times slower than the 5080 in float16 | Only as a fallback when CUDA is unavailable (already supported via `WHISPER_DEVICE=cpu`) |

## 5. Recommendations (ranked by expected gain ÷ effort)

The gains below are **estimates to verify with the §6 benchmark**, not measurements.

| # | Change | Where | Effort | Expected effect | Status |
|---|---|---|---|---|---|
| **R1** | **Shrink the hotword list.** Party characters plus glossary only (about 10–30 names). No Foundry monster compendium. No hotwords at all for clips under ~1.5 s. Keep the full name list for the LLM summary, where it helps | `bot/src/campaign.ts` `sttKeywords()`, or the worker decides per clip duration | Hours | Removes the F2 hallucinations and most temperature-fallback retries. Likely the largest single speedup | ✅ **Done in the worker.** `pick_hotwords()` sends at most `WHISPER_MAX_HOTWORDS=30` and none under `WHISPER_HOTWORDS_MIN_SECONDS=1.5`. The bot already orders party, then glossary, then actors, so the 30 are mostly party and glossary. The bot still sends up to 150 names over the wire (119 tonight, 115 from Foundry); optional follow-up: drop the actors from `sttKeywords()` |
| **R2** | **CPU VAD gate** (option A). Skip the model for clips with no detected speech, and pass `vad_filter=True` for the rest | `worker/scribworker/transcribe.py` `WhisperTranscriber` | Hours | Roughly halves the GPU queue (F3). Fewer junk lines in transcripts | ✅ **Done.** `has_speech()` (Silero on the CPU) skips silent clips; `vad_filter` trims the rest. `WHISPER_VAD`, `WHISPER_VAD_THRESHOLD`. Measured: ~51% of clips skipped |
| **R3** | **Bound decoding.** `beam_size` 1–2 for clips under ~5 s; `temperature=[0.0, 0.4]` instead of six steps; `max_new_tokens` proportional to clip length (e.g. 8 tokens/s + 16); keep `condition_on_previous_text=False`; tune `no_speech_threshold`/`log_prob_threshold`. Skip `word_timestamps` under ~5 s and use the segment's own timing | same | Hours | Caps the worst case per clip and removes pathological decodes | ✅ **Mostly done.** Temperatures `(0.0, 0.4, 0.8)`; `max_new_tokens` = 8/s + 16, capped at 200; `condition_on_previous_text=False`. Not done: beam stays 5 (now configurable, `WHISPER_BEAM_SIZE`) and `word_timestamps` is still on for every clip. Neither is needed at 0.14 s per clip |
| **R4** | **Raise `MIN_SEGMENT_MS`** from 250 to ~500–600 ms, and consider dropping clips whose RMS energy is below a floor | `bot/src/recorder.ts` | Minutes | Fewer clips enter the queue at all. Check against real sessions that short "yes"/"no" answers survive | ⏸ **Not done** (bot change), and no longer needed: VAD drops these clips in milliseconds |
| **R5** | **Batch on the GPU.** `BatchedInferencePipeline` (available in the installed faster-whisper 1.2.1), or drain up to N queued clips and run them as one batch. Keep it one thread and one model, so the CLAUDE.md rule still holds | worker `run()` loop | 1–2 days | Uses the idle GPU capacity (F4). Batching several 30-s windows costs far less than running them one at a time | ⏸ **Not needed.** The queue is empty live. Reconsider only for bulk re-transcription of the test corpus |
| **R6** | **Switch the model to `large-v3-turbo`** (4 decoder layers instead of 32; accuracy close to large-v3 for English). `distil-large-v3` is the other candidate | `.env` `WHISPER_MODEL` | Minutes, plus an accuracy check | Large decode speedup. Verify name accuracy on a fixture session first | ⏸ **Not needed.** large-v3 has ~12× headroom; keep its accuracy |
| **R7** | **CPU overflow worker** (option B): a second worker process on another port with `WHISPER_DEVICE=cpu`, int8, a small model, capped threads. The bot routes to it when the GPU worker's queue exceeds a threshold, or always for clips under ~2 s | bot `worker-client.ts` routing; worker unchanged | 1–2 days | Adds capacity in parallel with the GPU | ⏸ **Not needed** |
| **R8** | **Pack short clips.** Concatenate consecutive short clips from the *same speaker* into one window (with a short silence between) and split the result back by timestamps | worker | 2–3 days, riskier | Attacks F1 directly. Only worth it if R1–R6 still fall short | ⏸ **Not needed** |
| **R9** | **Drop filler phrases on short, unsure clips.** After decoding, drop a clip's text when all of it is a known silence phrase ("thank you", "thanks for watching", "you", "bye", "the end"…), the clip is under ~2 s, **and** its mean word probability is under ~0.7. A real "thank you" usually scores higher or comes in a longer clip, so it survives. Count the drops in `/health`, and make the thresholds configurable | worker `transcribe.py`, after `whisper_result_to_segments()` | Hours, plus a test | Removes almost all of the remaining top repeat (evidence below). Quality only, no speed change | ✅ **Done (2026-11-01).** `is_filler()` in `transcribe.py`; `WHISPER_FILLER_MAX_SECONDS` (2.0, 0 = off) and `WHISPER_FILLER_MAX_PROBABILITY` (0.7); `/health` counts `fillerDropped`. Takes effect on the next worker restart. The thresholds are not yet checked against `data/test-audio/` |

**Suggested first cut for the next session:** R1 + R2 + R3 + R4, then measure. If the measured rate is not comfortably above 30 clips/min, add R6, then R5.

**Outcome:** R1–R3 alone were enough; see the status note at the top. Remaining quality work, all optional and to be measured on `data/test-audio/` first:
- **R9** above: the "thank you" filter.
- Drop Foundry actors from `sttKeywords()` (bot), so the 30 hotword slots go to party and glossary names only.

**Evidence for R9 (session #13, 1,463 lines with text, checked 2026-10-31 late):**

| | Lines that are only "thank you" | All other lines |
|---|---|---|
| Count | 59 (58× "thank you", 1× "thank you. thank you"), ~4% | 1,404 |
| Median clip length | **0.88 s** (90% under 1.6 s) | 2.49 s |
| Median word probability | **0.57** | 0.86 |

- **Why it happens:** Whisper must produce text for any clip it's given. On a laugh, breath, "mm" or mic noise it falls back to the phrase most often attached to short non-speech in its training data (video subtitles): "Thank you." The phrase is common, so Whisper is confident in it.
- **Why the existing filters miss it:**
  - The Silero gate (R2) passes any voice-like sound, words or not.
  - Whisper's own no-speech skip needs a high no-speech score *and* a low log probability; a confident "thank you" fails the second test.
  - Hotwords and carried-over text are already off for these clips (R1, R3), so they aren't the cause.
- **Concentrated by speaker:** two players account for 50 of the 59 lines, and neither talks the most. The player with the most clips (601) has 3. This points to open mics or background noise.
- **Alternatives, weaker or riskier than R9:**
  - Store Whisper's per-segment `no_speech_prob` with each line and drop lines above a threshold. This is more general, but needs a field on the clip result (Pydantic, and Zod if the bot keeps it).
  - Raise `WHISPER_VAD_THRESHOLD` to ~0.6, or require a minimum speech length inside the clip. This risks losing real one-word answers like "yes" and "no".
- **At the table:** players with many such lines can use push-to-talk or Discord's noise suppression.

## 6. Measuring it (do this first)

> **Status:** item 1 (per-clip metrics) is ✅ **done**. `/health` has a `stats` block covering the last 5 minutes: clips/min, mean and p95 seconds, audio seconds, real-time factor, VAD skips, % kept. The monitor shows it. Item 2 (the benchmark) is **not yet run**. Its corpus is being collected: WAVs are kept in `data/test-audio/` and `DELETE_AUDIO_AFTER_TRANSCRIBE=false`. Item 3 (acceptance) is met on throughput; name accuracy hasn't been checked against a hand-corrected excerpt.

The worker currently reports only queue depth and done/failed counts, so tonight's per-clip cost had to be inferred. Before tuning:

1. **Per-clip metrics in the worker** (logged, and summarized on `/health`): audio seconds, decode wall-time, real-time factor, temperature fallbacks used, lines kept vs dropped as noise, and a rolling clips/min. The monitor's pipeline card can show them.
2. **A repeatable benchmark.** Copy a real session's clips plus timeline into a scratch folder (WAVs are deleted live, so keep them with `DELETE_AUDIO_AFTER_TRANSCRIBE=false` for one session). Then run each configuration over the same clips, with the live worker stopped so it doesn't compete for the GPU:

   | Run | Engine / model | Device | Hotwords | VAD | Beam | Batch |
   |---|---|---|---|---|---|---|
   | baseline | large-v3 | cuda fp16 | current (~130) | off | 5 | 1 |
   | R1 | large-v3 | cuda fp16 | party + glossary | off | 5 | 1 |
   | R1–R3 | large-v3 | cuda fp16 | trimmed | on | 1–2 | 1 |
   | + R6 | large-v3-turbo | cuda fp16 | trimmed | on | 1–2 | 1 |
   | + R5 | large-v3-turbo | cuda fp16 | trimmed | on | 1–2 | 8 |
   | CPU lane | large-v3-turbo / distil / small.en | cpu int8, 8 threads | trimmed | on | 1 | 1 |

   Record clips/min, mean and p95 seconds per clip, % of clips kept, and a word error rate (or a manual spot check of character names) against a hand-corrected 5-minute excerpt.
3. **Acceptance.** ≥ 55 clips/min on the GPU configuration that goes live, with name accuracy no worse than baseline on the excerpt.

## 7. Risks and trade-offs

- **Lower hotword coverage** may misspell rarely used monster names. Mitigation: they still reach the LLM through the glossary and actor list, and the summarizer corrects spelling there.
- **Aggressive VAD** can drop quiet one-word answers. Tune the threshold on real clips, and log what was dropped (duration, max RMS) so it can be audited.
- **Turbo or distil models** are less robust on accents and non-English. Keep `WHISPER_MODEL` configurable, as it is today.
- **Batching** increases latency per clip slightly. That's irrelevant for live, fire-and-forget clips.
- **Audio is deleted after transcription** (`DELETE_AUDIO_AFTER_TRANSCRIBE=true`). Any accuracy regression is permanent for that session. Benchmark before switching settings on a live night. *Mitigated:* `.env` now has `false`; the bot picks it up on its next restart.
