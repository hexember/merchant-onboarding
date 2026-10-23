---
name: ship
description: Autonomous pipeline for one task - plan, write the plan, review it against the ADRs, implement it, verify, then push a branch and open a draft PR. Use when the user runs /ship <task>.
argument-hint: <task description>
disable-model-invocation: true
---

Run this pipeline for the task: **$ARGUMENTS**

If no task was given, ask for one and stop. Invoking `/ship` is the user's request to commit,
push and open a draft PR for this task, and nothing more: never merge, never force-push, never
push to `main`.

Run the stages in order. You are the orchestrator: the subagents do the work, you pass
results between them and own git. Keep a one-line status per stage in your replies.

**Every stage below that names an agent is an `Agent` tool call** with `subagent_type` set to
that name; don't do its work yourself. Parallel agents go in **one message**. Subagents don't
see this conversation, so each prompt carries what it needs (task, slug, plan path, package ID,
findings).

## 0. Prepare

1. `git status --porcelain`: if the tree is dirty, stop and ask the user (don't stash or discard).
2. Pick a short kebab-case `<slug>` from the task (max ~5 words).
3. **Always create a new branch for this run**, whatever branch you are on now (`main`, or an
   `ai/*` branch from an earlier run). Never reuse or continue an existing branch.
   - Branch name: `<branch>` = `ai/<slug>-<stamp>`, where `<stamp>` is `date +%Y%m%d-%H%M`.
   - `git fetch origin main`
   - `git switch -c <branch> origin/main`
   - If that name already exists locally or on `origin` (`git ls-remote --heads origin <branch>`),
     append `-2`, `-3`, … until it is unused.
   - Check `git branch --show-current` prints `<branch>`. If it doesn't, stop and report.
   Use this exact `<branch>` everywhere below.

## 1. Plan

Launch the `planner` agent with: the task, the slug, and the plan path `docs/plans/<slug>.md`.

## 2. Review the plan (max 3 rounds)

Launch the `plan-reviewer` agent with the plan path. Read its `VERDICT`:

- `APPROVED` → go to stage 3.
- `CHANGES_REQUESTED` → launch `planner` again with the plan path and the reviewer's blockers
  verbatim, then review again. After 3 rounds without approval, stop and show the user the plan
  path and the remaining blockers.
- `NEEDS_HUMAN` → stop. Show the user the reviewer's question and the plan path. Resume from
  stage 2 when they answer (pass their answer to the planner).

## 3. Implement

Read the plan's `## Work packages` table and run it in **waves**:

1. A wave is every package whose "Depends on" packages are all finished. The first wave is the
   packages with no dependencies.
2. Launch one `implementer` per package in the wave, all in a single message (parallel). Prompt:
   plan path + `Package: <ID>`.
3. When the wave returns, check `git status --short`: every changed file must belong to the
   package that changed it. A file outside its package, or an implementer that reported it
   stopped → stop and report to the user. Don't commit broken work.
4. Repeat until every package is done.

## 4. Verify and review the code

This is the first time all packages are checked together.

1. If any implementer said the change touches auth, guards, application queries, logging, audit
   or seed/test data, launch the `security-reviewer` agent **in the same message** as you start
   step 2, so the review runs while the gate runs.
2. Run the `verify` skill yourself.
3. If `verify` fails or the security review has findings, launch one `implementer` with
   "whole plan" plus all the failures and findings verbatim, then re-run `verify`.
   One fix round only. Still failing, or unresolved high-severity findings → stop and report.

## 5. Commit, push, draft PR

1. `git status --short`. Stage only the files this task changed, by path (never `git add -A`).
   Refuse to stage `.env*` (except `.env.example`), anything in `dev.notes/`, or build output.
2. Commit with a conventional message: `<type>(<area>): <summary>`, a body listing the main
   changes, and `Plan: docs/plans/<slug>.md`.
3. `git push -u origin <branch>`
4. `gh pr create --draft --base main --head <branch> --title "<commit subject>" --body-file <tmp>`
   where the body has: **Summary** (the plan's Goal), **Plan** (link to `docs/plans/<slug>.md`),
   **ADR references**, **Tests** (the verify table), **Security review** (findings or "not
   needed"), and **Reviewer notes** (any plan-review suggestions not applied).

## 6. Report

Reply with the PR URL, the branch, the plan path, the verify table, and anything left for a human.
