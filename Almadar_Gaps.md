<!-- Gap ledger for this repo: the source of truth for its open gaps. Managed with scripts/gaps-ledger.mjs in the Almadar monorepo. -->
# @almadar/logger — open gaps

Every open gap this repo owns lives here. This file is the source of truth; the monorepo's `docs/Almadar_Gaps.md` only rolls it up.

- **One entry per gap:** `- **<code>** — <what is wrong and where>. <owning package> [mechanical|architectural] — <evidence, prevention rung>`. `[mechanical]` = small and well-scoped; `[architectural]` = needs design judgment.
- **Codes:** new gaps use this repo's prefix `G-LOGGER-`. Take the "Next code" below, then bump it in the same edit. Codes are never reused or renamed.
- **Close by deleting.** Remove the entry in the same commit as the fix. There is no "closed" section; git history is the record.
- **Cross-repo gaps don't go here.** If fixing it needs another repo, describe it in your report or PR body; the monorepo coordinator files it.

Next code: `G-LOGGER-002`

## Open gaps

- **G-LOGGER-001** — In a browser bundle `env.ts` sees no `process`, so `NODE_ENV` is unknown and the logger starts at DEBUG with every namespace allowed: every `debug`/`info` call formats its data and writes to the console unless the host sets a level (the builder's production client did not until 2026-10-04 — about 1 s of main thread on a 59-orbital world canvas). Decide the browser default (WARN unless a host opts in) — it changes every consumer's dev logging, so it is an owner call. `@almadar/logger` [architectural] — found 2026-10-04 (studio load perf CPU profile); prevention rung: unit test of the default level with no env
