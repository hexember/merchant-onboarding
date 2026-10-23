---
paths:
  - "src/kyb/**"
---

# KYB queue / worker rules

- Enqueue BullMQ jobs only after the DB transaction commits.
- Job ID: `kyb-check:{applicationId}:{submissionNo}`. Skip stale jobs (submission count changed,
  or status is no longer RISK_REVIEW). Rely on `UNIQUE(application_id, submission_no)` as the final guard.
- The worker is the only actor that moves an application RISK_REVIEW → UNDER_REVIEW, on success
  or after the final failure (`kybStatus=FAILED`). It audits as `actor_type=SYSTEM`. It is never a user.
- The provider sits behind the injectable `KybProvider` interface. Never call it outside the worker.
- Details: docs/adrs/kyb-check.md.
