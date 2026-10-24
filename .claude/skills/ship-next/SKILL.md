---
name: ship-next
description: Ship the next unchecked item in docs/backlog.md as a draft PR stacked on the previous item, then record it. Run it repeatedly with /loop /ship-next to work through the backlog unattended.
disable-model-invocation: true
---

Take the next item from [docs/backlog.md](../../../docs/backlog.md) and ship it with the `ship`
pipeline as a **stacked** draft PR. Running this command is the user's request to commit, push and
open draft PRs for backlog items, and nothing more: never merge, never force-push, never push to
`main`, never change permission settings.

## 1. Pick the item

1. Read `docs/backlog.md` fresh (the user may have edited it).
2. If any item is marked `- [!]`, stop: say which one and point to "Waiting on you". Don't skip
   past it, because later items build on it. If running under `/loop`, end the loop.
3. Take the first `- [ ]` item. Its slug is the bold word; the rest is the task. If there is
   none, report that the backlog is done and end the loop.

## 2. Pick the base branch

- The base is the branch recorded on the last `- [x]` item, or the "Stack starts on" branch if
  no item is shipped yet.
- If that branch's PR is merged (`gh pr view <branch> --json state -q .state` is `MERGED`), walk
  back to the nearest earlier unmerged branch; if every one is merged, use `main`.
- The base must exist on `origin`.

## 3. Ship it

Follow [.claude/skills/ship/SKILL.md](../ship/SKILL.md) exactly, with `--stack <base>` and the
item's task text, using the item's slug. Read that file each time; it is the source of truth for
the stages. While doing so, in unattended mode:

- **Don't wait for answers that have a safe default.** When the planner or reviewer raises an open
  question that the plan already resolves with a sensible default, keep the default, list it under
  the PR's **Reviewer notes**, and add one line to "Waiting on you".
- **Manual steps** the agents can't do (for example `.env.example` lines, which a permission rule
  blocks) go into "Waiting on you" and the PR body. They don't stop the run.
- **Stop conditions** are the ship pipeline's: `NEEDS_HUMAN`, no approval after 3 review rounds, a
  file outside its package, an implementer that stopped, the gate still failing after the fix
  round, or an unresolved high-severity finding. Then mark the item `- [!]`, add the reason and
  the question to the top of "Waiting on you", commit nothing else, and end the loop.

## 4. Record it

After the PR is open, on the same branch:

1. In `docs/backlog.md`, change the item to `- [x]` and append
   `— branch \`<branch>\`, PR <url>`. Add any new "Waiting on you" lines at the top of that section.
2. Commit only that file: `chore(backlog): record <slug>`, and `git push`.

## 5. Report

One short paragraph: the item, the PR URL, its base, the verify table result, and anything added
to "Waiting on you". Under `/loop`, continue with the next item on the next iteration.
