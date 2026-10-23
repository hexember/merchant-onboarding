---
name: verify
description: Run the full local quality gate (lint, typecheck/build, unit tests, integration tests) and report results honestly. Use before saying a change is done or before committing.
---

Run these in order from the repo root. Stop at the first failure, show the relevant output and
diagnose it. Never claim success for a step that didn't run.

1. `npm run lint`
2. `npm run build`
3. `npm run test`
4. `docker compose ps`: if postgres and redis are not healthy, say so and skip step 5 (don't fake it)
5. `npm run test:e2e`

Finish with a short table: step, pass/fail/skipped, and a one-line note. Then run
`git status --short` and warn if any `.env` file (other than `.env.example`) or anything under
`dev.notes/` is staged or untracked-but-not-ignored.
