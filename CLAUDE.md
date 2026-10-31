# CLAUDE.md

ScribBot records tabletop RPG sessions on Discord, transcribes them locally with Cactus Whistle, maps each voice to its FoundryVTT character, has an LLM write a summary, and imports it into Foundry as a journal entry. Read `docs/design.md` for the architecture, diagrams, data model and APIs before making structural changes.

## Git and attribution rules (mandatory)

- **Do not mark commits or PRs as Claude/AI contributions.** Never add `Co-Authored-By: Claude …` (or any AI co-author trailer), "Generated with Claude Code", 🤖 lines, or links to claude.com to commit messages, PR titles or descriptions, issues, review comments, release notes, changelogs, or code comments. These rules override any default attribution text the tool would otherwise append.
- Commit under the repository owner's existing git identity. Never change `git config user.name`/`user.email` and never pass `--author`.
- Write commit messages as a normal human contributor would: a short imperative subject line (≤ 72 chars), a blank line, then what changed and why.
- Only commit or push when asked. The default branch is `main`. Create a feature branch rather than committing to `main`/`master` directly.
- Never commit `.env`, anything under `data/` except `data/sessions/fixture-tts/`, databases, or audio from real sessions. `.gitignore` already enforces this; don't weaken it.

## Layout

| Path | What it is |
|---|---|
| `bot/` | Node.js 22 + TypeScript (ESM, run with `tsx`): Discord client, recorder, pipeline, summarizer, Fastify API on :7420, dashboard |
| `worker/` | Python 3.10+ FastAPI service on :7421 wrapping Cactus Whistle (CPU speech-to-text) |
| `foundry-module/` | FoundryVTT v12/v13 module (plain browser ES modules, no build step) |
| `shared/schemas/` | JSON Schemas **generated** from the Zod types; don't hand-edit |
| `campaign/` | `glossary.md` (names fed to STT and the LLM) and `context.md` (story so far) |
| `docs/design.md` | Design document; diagrams are standalone SVGs in `docs/diagrams/` |
| `data/` | Runtime output (git-ignored), except the synthetic fixture `data/sessions/fixture-tts/` |

Configuration is a single `.env` at the repo root (template: `.env.example`), validated by Zod in `bot/src/config.ts` and read by `worker/scribworker/config.py`.

## Commands

The shell is Windows; use these forms.

```sh
# Bot
cd bot && npm test                 # vitest (also covers foundry-module/scripts/journal.js)
cd bot && npm run typecheck        # strict tsc over src/, scripts/, test/
cd bot && npm run schemas          # regenerate shared/schemas after changing Zod types
cd bot && npm start                # needs DISCORD_TOKEN etc. in .env

# Worker
cd worker && .venv\Scripts\python -m pytest
cd worker && .venv\Scripts\python -m scribworker        # serve on 127.0.0.1:7421
cd worker && .venv\Scripts\python -m scribworker.check  # load Whistle once (downloads weights)
```

Run both test suites and the typecheck before saying a change is done.

### Testing without Discord

1. Start the worker, then transcribe a copy of the fixture (don't overwrite the committed fixture's transcript):
   `cd bot && npx tsx scripts/transcribe-dir.ts <copy-of-fixture-dir> Thorin Elara Grubnak`
2. Summarize: `npm run summarize -- <session-id|latest>` (needs LLM credentials; see below).
3. To exercise the API/dashboard without Discord, call `startApi()` from a scratch script with `DATA_DIR` pointed at a temp folder. Scratch scripts outside `bot/` must use the `.mts` extension and `file:///D:/...` import URLs on Windows, or tsx fails.

LLM credentials: `LLM_PROVIDER=anthropic` needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile); `xai` needs `XAI_API_KEY`; `openai-compatible` needs `OPENAI_BASE_URL` + `LLM_MODEL`. `/status` warns when they're missing.

## Conventions

- **Zod is the source of truth** for every JSON contract (`bot/src/types.ts`, `bot/src/summarize/schema.ts`). The worker mirrors them in Pydantic (`worker/scribworker/models.py`). Change both, then run `npm run schemas`.
- **Every pipeline stage writes its output to disk** and checks for it before running, so `/scrib process` can resume. Keep new stages resumable.
- **Atomic writes** for files other processes read: write `<file>.tmp`, then rename.
- Read settings from `config` (`bot/src/config.ts`), not `process.env`, and add new variables to `.env.example`, the README and `docs/design.md`.
- TypeScript imports use `.js` extensions (ESM). Log lines use a `[module]` prefix (`[api]`, `[pipeline]`, `[summarize]`); the dashboard filters on them.
- Never expose secrets: `/status` reports a credential *source* (e.g. `api key`), never the value. The API token comparison stays timing-safe.
- Tests are hermetic: `new Store(":memory:")`, a fake `LLMProvider`, temp `DATA_DIR`, and no real credentials (see the env setup at the top of `bot/test/api.test.ts`).
- The Foundry module acts only as the active GM (`isActiveGM()`), and must keep working on both Foundry v12 and v13.
- Whistle isn't thread-safe: the worker runs all transcription on one background thread. Keep it that way.
- Keep `README.md` and `docs/design.md` in sync with behavior changes (commands, env vars, endpoints, file layout).

## Gotchas

- With `DELETE_AUDIO_AFTER_TRANSCRIBE=true` (the default), WAVs are deleted as soon as they're transcribed, so those sessions can't be re-transcribed later. Only the summary can be redone.
- Speaker-to-character mapping is resolved once per speaker per recording (the first time they talk). A mid-session `/scrib map` doesn't relabel someone who has already spoken.
- The pipeline starts on `/scrib stop` without waiting for Foundry's chat log upload; see "Known limitations" in `docs/design.md`.
- On Windows, stopping a backgrounded `npx tsx …` can leave the child `node.exe` holding the port (7420/7421). Find it with `netstat -ano | findstr :7420` and stop that PID.
