# Test plan

- **Unit:** state machine (every allowed and every rejected transition, including that `KYB_COMPLETE` is not reachable from any user action), policy/scoping logic,
  masking/redaction, the `kybLevel` → `label` mapping (including `null`), worker idempotency (duplicate job, stale job, retry, final failure).
- **Integration (Supertest, real Postgres + Redis):** login; the lifecycle happy path
  (DRAFT → RISK_REVIEW → UNDER_REVIEW → APPROVED); request info → resubmit → back to
  RISK_REVIEW with a new KYB check; invalid transitions → 409 (e.g. deciding while in
  RISK_REVIEW, approving with `kybStatus=FAILED`); KYB processing end to end (success, retry then
  success, retries used up → UNDER_REVIEW + FAILED); and **explicit bypass attempts**:
  - SALES A cannot GET/PATCH/submit SALES B's application by ID (404)
  - after ADMIN transfers an application from SALES A to B, A gets 404 and B has access
  - SALES cannot transfer ownership (403), and cannot set `salesOwnerId` on create (403)
  - ADMIN cannot transfer to a non-SALES user (400)
  - SALES cannot assign or decide (403)
  - a non-assigned REVIEWER cannot decide (404)
  - ADMIN cannot decide (403)
  - mass-assignment fields (`createdById`, `status`, `kybStatus`, `kybLevel`, and `salesOwnerId` on PATCH) are rejected (400)
  - an application ID that does not exist → 404 (same response as out of scope)
  - no token or a tampered token → 401
- Tests must not depend on randomness. Inject a deterministic fake `KybProvider`.
