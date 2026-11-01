# CLAUDE.md

ScribBot records tabletop RPG sessions on Discord, transcribes them locally with Cactus Whistle, maps each voice to its FoundryVTT character, has an LLM write a summary, and imports it into Foundry as a journal entry. Read `docs/design.md` for the architecture, diagrams, data model and APIs before making structural changes.

## Git and attribution rules (mandatory)

- **Do not mark commits or PRs as Claude/AI contributions.** Never add `Co-Authored-By: Claude …` (or any AI co-author trailer), "Generated with Claude Code", 🤖 lines, or links to claude.com to commit messages, PR titles or descriptions, issues, review comments, release notes, changelogs, or code comments. These rules override any default attribution text the tool would otherwise append.
- Commit under the repository owner's existing git identity. Never change `git config user.name`/`user.email` and never pass `--author`.
- Write commit messages as a normal human contributor would: a short imperative subject line (≤ 72 chars), a blank line, then what changed and why.
- Only commit or push when asked. The default branch is `main`. Create a feature branch rather than committing to `main`/`master` directly.
- Never commit `.env`, anything under `data/` except `data/sessions/fixture-tts/`, `campaign/` files other than the `*.example.md` templates, databases, or audio from real sessions. `.gitignore` already enforces this; don't weaken it.

## Layout

| Path | What it is |
|---|---|
| `bot/` | Node.js 22 + TypeScript (ESM, run with `tsx`): Discord client, recorder, pipeline, summarizer, Fastify API on :7420, dashboard |
| `worker/` | Python 3.10+ FastAPI service on :7421 wrapping Cactus Whistle (CPU speech-to-text) |
| `monitor/` | Optional read-only watchdog on :7422 (`scribmonitor.py`, stdlib only): redirects to the bot's dashboard, or shows a fallback page while the bot is down. Nothing may depend on it |
| `foundry-module/` | FoundryVTT v12/v13 module (plain browser ES modules, no build step) |
| `shared/schemas/` | JSON Schemas **generated** from the Zod types; don't hand-edit |
| `campaign/` | `glossary.md` (names fed to STT and the LLM) and `context.md` (story so far). Both are git-ignored and local only; change the committed `*.example.md` templates instead |
| `docs/design.md` | Design document; diagrams are standalone SVGs in `docs/diagrams/` |
| `.claude/skills/summarize-session/` | Story write-up skill (stdlib Python + prompt, any LLM); `template.md` fixes the sections, `verify.py` checks the result. Writes to `data/sessions/<id>/story/` |
| `data/` | Runtime output (git-ignored), except the synthetic fixture `data/sessions/fixture-tts/` |

Configuration is a single `.env` at the repo root (template: `.env.example`), validated by Zod in `bot/src/config.ts` and read by `worker/scribworker/config.py`.

## Commands

The shell is Windows; use these forms.

```sh
# Bot
cd bot && npm test                 # vitest (also covers foundry-module/scripts/journal.js)
cd bot && npm run typecheck        # strict tsc over src/, scripts/, test/
cd bot && npm run schemas          # regenerate shared/schemas after changing Zod types
cd bot && npm run foundry          # join Foundry once as the headless bridge user (FOUNDRY_* in .env)
cd bot && npm start                # needs DISCORD_TOKEN etc. in .env

# Worker
cd worker && .venv\Scripts\python -m pytest
cd worker && .venv\Scripts\python -m scribworker        # serve on 127.0.0.1:7421
cd worker && .venv\Scripts\python -m scribworker.check  # load Whistle once (downloads weights)

# Monitor (optional)
cd monitor && ..\worker\.venv\Scripts\python -m pytest
.\start-monitor.ps1                                      # watchdog on 127.0.0.1:7422 (redirects to :7420 while the bot runs)
```

Run the bot, worker and monitor test suites and the typecheck before saying a change is done.

### Testing without Discord

1. Start the worker, then transcribe a copy of the fixture (don't overwrite the committed fixture's transcript):
   `cd bot && npx tsx scripts/transcribe-dir.ts <copy-of-fixture-dir> Thorin Elara Grubnak`
2. Summarize: `npm run summarize -- <session-id|latest>` (needs LLM credentials; see below).
3. To exercise the API/dashboard without Discord, call `startApi()` from a scratch script with `DATA_DIR` pointed at a temp folder. Scratch scripts outside `bot/` must use the `.mts` extension and `file:///D:/...` import URLs on Windows, or tsx fails.

LLM credentials: `LLM_PROVIDER=anthropic` needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile); `xai` needs `XAI_API_KEY`; `openai-compatible` needs `OPENAI_BASE_URL` + `LLM_MODEL`. `/status` warns when they're missing.

## Conventions

- **Zod is the source of truth** for every JSON contract (`bot/src/types.ts`, `bot/src/summarize/schema.ts`). The worker mirrors them in Pydantic (`worker/scribworker/models.py`). Change both, then run `npm run schemas`.
- **Every pipeline stage writes its output to disk** and checks for it before running, so `/scrib process` can resume. Keep new stages resumable.
- **Atomic writes** for files other processes read: use `writeFileAtomic()` (`bot/src/fsutil.ts`), which writes `<file>.tmp` and renames with retries on Windows `EPERM`/`EBUSY`.
- **`timeline.json` is a snapshot.** The recorder appends each clip to `timeline.segments.jsonl` and snapshots `timeline.json` every ~30 s. Read timelines with `readTimeline()` (bot) or `load_timeline()` (worker), never by parsing `timeline.json` alone, and never open it while the bot is recording that session.
- **Nothing on the recording path may throw into the void.** Clip callbacks catch and log (`[recorder]`); new EventEmitters (connections, clients) get an `error` listener. An unhandled exception ends the recording.
- Read settings from `config` (`bot/src/config.ts`), not `process.env`, and add new variables to `.env.example`, the README and `docs/design.md`.
- TypeScript imports use `.js` extensions (ESM). Log lines use a `[module]` prefix (`[api]`, `[pipeline]`, `[summarize]`); the dashboard filters on them.
- Never expose secrets: `/status` reports a credential *source* (e.g. `api key`), never the value. The API token comparison stays timing-safe.
- Tests are hermetic: `new Store(":memory:")`, a fake `LLMProvider`, temp `DATA_DIR`, and no real credentials (see the env setup at the top of `bot/test/api.test.ts`).
- The Foundry module talks to the bot only from the bridge client (`role()` in `scripts/main.js`, logic in `scripts/roles.js`): the active GM by default, or the **Bridge user** setting. GM-only writes (journals, the combat log) stay with the active GM, relayed over the module socket. It must keep working on both Foundry v12 and v13.
- Whistle isn't thread-safe: the worker loads the model and runs all transcription on one background thread, for both engines (`STT_ENGINE=whistle|whisper`). Keep it that way. Whisper (`faster-whisper`) is an optional extra; the worker must still import and run without it.
- Keep `README.md` and `docs/design.md` in sync with behavior changes (commands, env vars, endpoints, file layout).

## Gotchas

- With `DELETE_AUDIO_AFTER_TRANSCRIBE=true` (the default), WAVs are deleted as soon as they're transcribed, so those sessions can't be re-transcribed later. Only the summary can be redone.
- Speaker-to-character mapping is resolved once per speaker per recording (the first time they talk). A mid-session `/scrib map` doesn't relabel someone who has already spoken.
- The pipeline starts on `/scrib stop` without waiting for Foundry's chat log upload; see "Known limitations" in `docs/design.md`.
- On Windows, stopping a backgrounded `npx tsx …` can leave the child `node.exe` holding the port (7420/7421). Find it with `netstat -ano | findstr :7420` and stop that PID.
- `start.ps1` and `start-worker.ps1` restart a process that exits non-zero. To stop for good, use Ctrl+C (exit 0) or `-NoRestart`; killing the process makes it come back.
- After a restart the bot rejoins a session that was recording less than `RESUME_WINDOW_MINUTES` ago. When testing restarts against real data, expect it to rejoin the voice channel.
- Windows PowerShell 5.1 has no `&&`; chain with `;`.
