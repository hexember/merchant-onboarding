Async KYB check: idempotency

On SUBMIT, one DB transaction does all of the following: sets `status=RISK_REVIEW` and
`kybStatus=PENDING`, clears `kyb_level`/`kyb_score`, resets `kyb_attempts` to 0, increments `submission_count` (to `n`), and
writes the audit row. **After the commit**, the service enqueues a BullMQ job with:

- `jobId = kyb-check:{applicationId}:{n}`: BullMQ ignores a second job with the same ID, which
  removes duplicate enqueues
- `attempts = 5`, `backoff = { type: 'exponential', delay: 2000 }` (2s, 4s, 8s, 16s)

The worker processes a job like this:
1. Load the application. If `submission_count != n` or `status != RISK_REVIEW`, the job is
   **stale** (the application was resubmitted, or this submission was already processed). Ack it
   and do nothing.
2. If a `kyb_checks` row for `(applicationId, n)` already exists, the work is already done. Ack it.
3. Increment `kyb_attempts`, set `kyb_last_attempt_at`, then call the simulated provider. It
   fails at a configurable rate, which exercises the retries. A failed attempt writes a
   `KYB_CHECK_ATTEMPT_FAILED` audit row and rethrows the error, so BullMQ schedules the retry.
4. On success, in one transaction:
   - `INSERT kyb_checks ... ON CONFLICT (application_id, submission_no) DO NOTHING`
   - `UPDATE merchant_applications SET status='UNDER_REVIEW', kyb_status='COMPLETED', kyb_level=?, kyb_score=?
     WHERE id=? AND submission_count=n AND status='RISK_REVIEW'`
   - write a `KYB_CHECK_COMPLETED` audit row (`actor_type=SYSTEM`)
5. On the final failed attempt, set `status='UNDER_REVIEW'` and `kybStatus='FAILED'`, using the
   same `WHERE` guard, and write `KYB_CHECK_FAILED`.

So the work is idempotent at three layers: the job ID, the stale check, and the unique
constraint, backed by the conditional `UPDATE`. A job that is delivered twice, or a worker that
crashes after the provider call but before the commit, produces at most one stored result and one
status change.

**trade-off** The service enqueues after the commit, not through a transactional outbox. If Redis
is down at that moment, the application stays in `RISK_REVIEW` with no job. A production fix would be an
outbox table, or a sweeper that re-enqueues `RISK_REVIEW` applications older than X minutes. I'll
document this rather than build it. A job that BullMQ fails as stalled (more than `maxStalledCount`) never reaches the processor, so that application also stays in `RISK_REVIEW`; the same outbox or sweeper fix covers it.

The simulated provider sits behind an injectable `KybProvider` interface. Tests swap
in a deterministic fake. Locally, the score is derived from MCC and volume, plus some randomness.