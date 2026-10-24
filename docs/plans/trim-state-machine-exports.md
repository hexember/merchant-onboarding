# Trim test-only state-machine exports and comment the application DTOs

## Goal
`application-state-machine.ts` no longer exports anything that only its spec uses:
`canTransition` is deleted, and `TERMINAL_STATUSES` and `USER_TRANSITION_ACTIONS` become local
constants in the spec. The validation patterns in `create-application.dto.ts` and the page-size
constants in `list-applications-query.dto.ts` get short comments that make sense on their own.
Runtime behaviour, every regex, every value and the unit and e2e test counts stay the same.

## Scope
- In: `src/applications/application-state-machine.ts`,
  `src/applications/application-state-machine.spec.ts`,
  `src/applications/dto/create-application.dto.ts`,
  `src/applications/dto/list-applications-query.dto.ts`. The changes are comments and moving
  code only.
- Out: any regex, value or validation change; `nextStatus`, `nextSystemStatus`, `fromStatuses`,
  `isRoleAllowed`, `TRANSITIONS`, `OPERATIONS`, `isOperationAllowed`, `allowedStatuses`,
  `DECISION_ACTIONS`, `requiresCompletedKyb` (they stay as they are); ADRs; older plan files
  (`docs/plans/submit-lifecycle.md` mentions the removed names, but it is a historical record and
  stays as it is).

## ADR references
- docs/adrs/workflow.md §1.1 / §1.2: the transition table stays data in `TRANSITIONS`. Terminal
  statuses are still APPROVED and REJECTED, and the spec still checks this with its local
  `TERMINAL_STATUSES`. No row, guard or operation changes.
- docs/adrs/database.md (applications table): the comments match the column notes:
  `merchant_category_code char(4)` "MCC, e.g. `5411`", `currency char(3)` "ISO 4217, default
  `NPR`", `owner_phone varchar(30)`.
- docs/adrs/auth.md (`GET /applications?status&page&limit`): pagination limits are unchanged.
- docs/adrs/testing.md: no authz rule is touched, so no denied case needs to be added or changed.

## ADR conflicts
None.

## Steps

Pre-check (already done while planning, the implementer runs it again): a grep for
`canTransition|TERMINAL_STATUSES|USER_TRANSITION_ACTIONS` across `src/` and `test/` finds them
only in `src/applications/application-state-machine.ts` (the definitions) and
`src/applications/application-state-machine.spec.ts`. `test/` has no hits. Outside the code, the
only hits are in `docs/plans/submit-lifecycle.md`, which stays as it is. So all three can go.

1. `src/applications/application-state-machine.ts`
   - Delete `export const USER_TRANSITION_ACTIONS` (lines 36–41). Keep the
     `UserTransitionAction` type and its doc comment.
   - Delete `TERMINAL_STATUSES` and its doc comment (lines 127–131).
   - Delete `canTransition` and its doc comment (lines 157–160).
   - Nothing else changes. The header comment does not mention these names, so it stays.

2. `src/applications/application-state-machine.spec.ts`
   - Remove `TERMINAL_STATUSES`, `USER_TRANSITION_ACTIONS` and `canTransition` from the import.
   - After `const ALL_STATUSES = ...`, add these local constants. The values and order are the
     same as the deleted exports:
     ```ts
     // Statuses with no outgoing transition (docs/adrs/workflow.md §1.1).
     const TERMINAL_STATUSES: readonly ApplicationStatus[] = [S.APPROVED, S.REJECTED];
     // Every action a user may trigger, i.e. every TransitionAction except KYB_COMPLETE.
     const USER_TRANSITION_ACTIONS: readonly UserTransitionAction[] = [
       A.SUBMIT,
       A.APPROVE,
       A.REJECT,
       A.REQUEST_INFO,
     ];
     ```
     `TERMINAL_STATUSES` must come after `const S` and `USER_TRANSITION_ACTIONS` after `const A`.
     Both must come before `STATUS_ACTION_PAIRS`, which uses `USER_TRANSITION_ACTIONS`.
   - Replace the three `canTransition` assertions. In each case the line just before already
     asserts the same `nextStatus(...)` call:
     - Line 67, `it.each(STATUS_ACTION_PAIRS)`: replace with
       `expect(nextStatus(status, action) !== null).toBe(expected !== null);`.
     - Line 81, `rejects %s --%s-->`: after the swap to `toBeNull()` it would be an exact copy of
       line 80 (`expect(nextStatus(status, action)).toBeNull();`), so delete it. The case stays.
     - Line 105, the cast-`KYB_COMPLETE` runtime check: same reason, it would copy line 104, so
       delete it. The case and its line-104 assertion
       `nextStatus(status, A.KYB_COMPLETE as unknown as UserTransitionAction)` → `toBeNull()` stay.
   - Keep every `it`/`it.each` and every row, with the same titles.

3. `src/applications/dto/create-application.dto.ts`
   - Line 19: replace `// Validation formats shared by the create and update DTOs (see the plan's
     Risks for the choices).` with a comment that does not point at a plan file, e.g.
     `// Validation formats shared by the create and update DTOs. Each one matches its column in
     docs/adrs/database.md.`
   - Add a one-line comment above each pattern. Do not change any regex:
     - `MCC_PATTERN` (`/^\d{4}$/`): `// Exactly 4 digits: a merchant category code, e.g. 5411.`
     - `CURRENCY_PATTERN` (`/^[A-Z]{3}$/`): `// Exactly 3 uppercase letters: an ISO 4217 currency code, e.g. NPR.`
     - `PHONE_PATTERN` (`/^\+?[0-9][0-9 ()-]{5,28}$/`), see the arithmetic below:
       `// Optional leading +, a digit, then 5–28 digits/spaces/()/-: 6–29 chars, or 7–30 with the +
       (fits maxLength 30), e.g. +977-0000000123.` If the line runs past the formatter width,
       split it into two comment lines.
   - Phone arithmetic, checked against the actual regex: `\+?` is 0–1 chars, `[0-9]` is 1 char,
     and `[0-9 ()-]{5,28}` is 5–28 chars. That gives 6–29 chars without the `+` and 7–30 with it.
     The task text says "7–30 chars total". That is only right when the `+` is present: a string
     with no `+` can be as short as 6 chars (e.g. `123456` matches). The upper bound, 30, equals
     `@MaxLength(30)` / `maxLength: 30` and only `+` strings reach it. The comment above states the
     real range.

4. `src/applications/dto/list-applications-query.dto.ts`
   - Above `DEFAULT_PAGE_SIZE`: `/** Number of items returned when the client sends no \`limit\` (20). */`
   - Above `MAX_PAGE_SIZE`: `/** Largest \`limit\` a client may ask for; a bigger value gets a 400. */`
   - Leave the `MAX_PAGE` comment and all values as they are.

## Tests
- Unit, current baseline for `src/applications/application-state-machine.spec.ts`, counted per
  executed case with each `it.each` row as one case (6 statuses, 4 user actions, 3 roles,
  3 decision actions, 3 operations):
  - user transitions: 1 + 1 + 24 (pairs) + 8 (rejects rows) + 2 (terminal) = 36
  - KYB_COMPLETE unreachable: 1 + 1 + 6 (cast, per status) + 1 + 1 + 1 + 6 (nextSystemStatus) = 17
  - table integrity: 4
  - fromStatuses: 3
  - isRoleAllowed: 12 + 3 = 15
  - decision actions: 1 + 1 + 1 + 3 + 15 (other pairs) + 3 + 3 = 27
  - operations: 1 + 1 + 18 + 2 + 1 + 1 + 1 = 25
  - **Total: 127 cases** (19 `it(` and 16 `it.each(` call sites). Jest should report 127 for
    this file both before and after the change.
- Merged cases: **none**. No case tested only `canTransition`. All three `canTransition`
  assertions sat next to a `nextStatus` assertion in the same case, in the `%s --%s-->` pairs
  (24), `rejects %s --%s-->` (8) and `nextStatus(%s, KYB_COMPLETE cast) is null` (6). So no case
  is removed or merged, and the PR body can say "no cases merged; 127 → 127".
- Denied/invalid coverage that stays: the `rejects` rows, the terminal-status cases, the
  cast-`KYB_COMPLETE` runtime check, and the `isRoleAllowed` false rows.
- DTO files: only comments change, so no new tests. The existing DTO validation specs and e2e
  tests must pass with unchanged counts.
- Integration/e2e: no change. Record the total e2e count from `/verify` before and after; they
  must be equal.

## Work packages
| ID | Steps | Files (exclusive) | Depends on |
|----|-------|-------------------|------------|
| A  | 1, 2  | src/applications/application-state-machine.ts, src/applications/application-state-machine.spec.ts | — |
| B  | 3, 4  | src/applications/dto/create-application.dto.ts, src/applications/dto/list-applications-query.dto.ts | — |

No wiring package is needed: no module, `main.ts` or `package.json` changes.

## Security notes
- No authz path is touched. Scoped repository lookups, 404/403 behaviour and the
  assigned-reviewer rule are unchanged.
- The comments use only the fake examples already in the file and ADR (`5411`, `NPR`,
  `+977-0000000123`). No PII, secrets or logging changes.
- The comment on line 19 stops pointing at a plan file, so it stands alone and quotes nothing from
  `dev.notes/`.

## Risks / open questions
- Phone range: the task said "7–30 chars total". The real regex accepts 6–29 without `+` and 7–30
  with it, and the plan's comment says that. No regex change is planned. Whether a 6-digit phone
  with no `+` should be valid is a product question; it is not raised here because the regex must
  not change.
- Step 2 deletes, rather than rewrites, the `canTransition` lines in the `rejects` and cast cases,
  because with `toBeNull()` they would be exact copies of the line above. This drops 2 duplicate
  assertions but no case. If the reviewer would rather keep a literal replacement, use
  `expect(nextStatus(...) !== null).toBe(false)`. The case count is the same either way.
