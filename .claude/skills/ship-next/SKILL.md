---
name: ship-next
description: Ship the next unchecked item in docs/backlog.md as a draft PR stacked on the previous item, then record it. Run it repeatedly with /loop /ship-next to work through the backlog unattended.
disable-model-invocation: true
---

Take the next item from [docs/backlog.md](../../../docs/backlog.md) and ship it with the `ship`
pipeline as a **stacked** draft PR. Running this command is the user's request to commit, push and
open draft PRs for backlog items, and nothing more: never merge, never force-push, never push to
`main`, never change permission settings, never read `.env`.

**Work in a dedicated git worktree**, never in the user's own checkout, so their edits and the
loop's branch switches can't collide. Tell every subagent the worktree path and that it must not
touch files outside it.

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
- **Pick up the user's changes instead of stopping.** Before branching, and again before the
  commit in stage 5 of the ship pipeline, `git fetch origin`. If the base (or any branch below it,
  or `main`) has commits the current branch lacks, merge them in with a normal merge commit
  (`git merge --no-edit`; never rebase or force-push). The user's version wins on conflicts:
  hand the conflicts to an `implementer` with that rule, re-run the gate, then commit the merge
  yourself.

## 3. Ship it

Follow [.claude/skills/ship/SKILL.md](../ship/SKILL.md) exactly, with `--stack <base>` and the
item's task text, using the item's slug. Read that file each time; it is the source of truth for
the stages. In unattended mode these rules **override** the ship pipeline where they differ:

- **Never wait for an answer.** For any open question, including a `NEEDS_HUMAN` verdict, choose
  the safest option consistent with the ADRs and `.claude/rules/`, pass it to the planner as the
  decision, record it under the PR's **Reviewer notes** and add one line to "Waiting on you".
  Then carry on.
- **Plan review: up to 3 rounds, then continue.** If the plan still isn't approved after 3
  rounds, go ahead with the latest revision (the one with the fewest blockers) and list the open
  blockers in the PR. Stop only if a remaining blocker is security-relevant (authz bypass, secret
  or sensitive-data exposure, injection).
- **Gate and security fixes: up to 3 fix rounds** instead of 1. Each round is one `implementer`
  with "whole plan" plus all remaining failures and findings verbatim, followed by `verify`.
- **A file outside its package, or an implementer that stopped,** is not a stop: have the planner
  assign the file or the missing step to a package (usually the final one), then continue.
- **Manual steps** the agents can't do (for example `.env.example` lines, which a permission rule
  blocks) go into "Waiting on you" and the PR body. They don't stop the run.
- **Stop only when** the gate still fails after 3 fix rounds, a high-severity security finding is
  still unresolved, or a security-relevant plan blocker remains after 3 review rounds. Then mark
  the item `- [!]`, add the reason and the question to the top of "Waiting on you", commit nothing
  else, and end the loop.

## 4. Record it

After the PR is open, on the same branch:

1. In `docs/backlog.md`, change the item to `- [x]` and append
   `— branch \`<branch>\`, PR <url>`. Add any new "Waiting on you" lines at the top of that section.
2. Commit only that file: `chore(backlog): record <slug>`, and `git push`.

## 5. Report

One short paragraph: the item, the PR URL, its base, the verify table result, and anything added
to "Waiting on you". Under `/loop`, continue with the next item on the next iteration.
