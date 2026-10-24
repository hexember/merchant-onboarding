# Tables

All primary keys are UUIDs, so IDs cannot be guessed or enumerated. All timestamps are
`timestamptz`. Enums are Postgres enums created in migrations.

**`meta` columns.** `merchant_applications`, `kyb_checks` and `audit_logs` each have a
`meta jsonb NOT NULL DEFAULT '{}'` column for extra context that has no fixed shape. The rules:
- **Server-written only.** No client DTO accepts `meta`, which closes it to mass assignment.
- **Never holds PII or secrets.** Every write goes through `redact()` first.
- **Never holds anything a rule, filter or index depends on.** If code branches on a value, or a
  query filters by it, the value gets a real typed column instead.
- **Small.** Writes are capped (e.g. 8 KB); it is context, not storage.
- It is not returned in API responses, except in the ADMIN audit-log endpoint.

_(decision)_ The `meta` columns give room to grow without a migration for non-critical context.
The guardrails stop them from becoming a schemaless side-table that hides business data, PII or
rules from the schema. `users` has no `meta`, because nothing about a user needs one.

## `users`
| column          | type            | notes                         |
|-----------------|-----------------|-------------------------------|
| id              | uuid PK         |                               |
| email           | varchar unique  | stored lowercased             |
| password_hash   | varchar         | bcrypt; never selected by default (`select: false`) |
| full_name       | varchar         |                               |
| role            | enum `user_role` | ADMIN / REVIEWER / SALES     |
| created_at, updated_at | timestamptz |                             |

Only seeded fake users exist. There is no sign-up endpoint (it is out of scope).

## `merchant_applications`
| column                     | type              | notes |
|----------------------------|-------------------|-------|
| id                         | uuid PK           | |
| created_by_id              | uuid FK users     | who created the row (SALES or ADMIN); immutable, history only |
| sales_owner_id             | uuid FK users     | the SALES user who owns the application; **drives SALES access**; changeable only by ADMIN transfer |
| assigned_reviewer_id       | uuid FK users null | |
| business_name              | varchar(200)      | trading name |
| legal_business_name        | varchar(200)      | |
| business_type              | enum              | SOLE_PROPRIETORSHIP, PARTNERSHIP, PRIVATE_LIMITED, PUBLIC_LIMITED, NON_PROFIT |
| registration_number        | varchar(50)       | company registration no. |
| tax_id                     | varchar(50)       | **sensitive** (PAN/VAT) |
| owner_full_name            | varchar(200)      | PII |
| owner_email                | varchar(254)      | PII |
| owner_phone                | varchar(30)       | PII |
| owner_national_id          | varchar(50)       | **sensitive** |
| merchant_category_code     | char(4)           | MCC, e.g. `5411` |
| website_url                | varchar(500) null | |
| expected_monthly_volume_minor | bigint         | money in minor units (paisa); avoids float rounding |
| average_ticket_size_minor  | bigint            | |
| currency                   | char(3)           | ISO 4217, default `NPR` |
| status                     | enum              | see [workflow.md](workflow.md) §1.1 |
| kyb_status          | enum              | see [workflow.md](workflow.md) §1.3 |
| kyb_level                 | enum null         | [workflow.md](workflow.md) §1.3; null until a check completes |
| kyb_score                 | smallint null     | latest result, copied from `kyb_checks` for list/filter |
| kyb_attempts              | smallint default 0 | provider attempts for the current submission; reset on SUBMIT (progress, [workflow.md](workflow.md) §1.4) |
| kyb_last_attempt_at       | timestamptz null  | |
| submission_count           | int default 0     | incremented on every SUBMIT; used as the idempotency key ([kyb-check.md](kyb-check.md)) |
| decision_note              | text null         | |
| submitted_at, decided_at   | timestamptz null  | |
| version                    | int               | optimistic lock (`@VersionColumn`) |
| meta                       | jsonb default '{}' | server-written context, e.g. `{ "source": "api", "requestId": "…" }` |
| created_at, updated_at     | timestamptz       | |

Indexes:
- `(sales_owner_id, created_at DESC)`: the SALES "my applications" list
- `(assigned_reviewer_id, status)`: the reviewer queue
- `(status, created_at DESC)`: the ADMIN list with a status filter

**Who created an application and who owns it are separate columns.**
- `created_by_id` is a fixed fact: who created the row. It never changes.
- `sales_owner_id` decides which SALES user can see and edit the application.

When SALES creates an application, both are set to that user. When ADMIN creates one, ADMIN must
name a SALES user as `salesOwnerId`. Otherwise no SALES user could ever work on it. ADMIN can also
transfer ownership later, e.g. when a sales rep leaves. The service checks that the target user has
the SALES role. The name is `sales_owner_id` rather than `owner_id`, because the `owner_*` columns
describe the merchant's business owner.

The spec says SALES may access "only the applications they created". With this
design, access follows `sales_owner_id`, which equals the creator unless ADMIN created the
application on someone's behalf or transferred it. This is the deliberate, documented exception,
and only ADMIN can trigger it.

**Owner/contact and processing info are flat columns, not JSONB.** Flat columns get
DB-level types and constraints, are easy to validate, and make it clear which column is sensitive
(and would need encryption). The cost is a wider table. One owner per application is enough here.
Supporting several owners or directors would need a child table.

## `kyb_checks`
| column          | type          | notes |
|-----------------|---------------|-------|
| id              | uuid PK       | |
| application_id  | uuid FK       | |
| submission_no   | int           | the `submission_count` value this check belongs to |
| provider_reference | varchar    | the simulated provider's ID |
| score           | smallint      | 0–100 |
| level           | enum          | LOW / MEDIUM / HIGH |
| reasons         | jsonb         | e.g. `["HIGH_RISK_MCC"]`; contains no PII |
| meta            | jsonb default '{}' | redacted provider details, e.g. `{ "providerVersion": "sim-1", "latencyMs": 420, "attempt": 2 }` |
| created_at      | timestamptz   | |

**`UNIQUE (application_id, submission_no)`**: the DB-level guarantee that each submission gets
exactly one result.

## `audit_logs` (append-only)
| column      | type          | notes |
|-------------|---------------|-------|
| id          | uuid PK       | |
| actor_type  | enum          | USER / SYSTEM |
| actor_id    | uuid null     | set when actor_type = USER; null for SYSTEM, and null for LOGIN_FAILED (the caller is not authenticated; entity_id names the targeted user when the email matched one) |
| actor_role  | enum null     | the user's role at the time of the action; null when actor_id is null |
| actor_label | varchar null  | for SYSTEM, the component name, e.g. `kyb-worker` |
| action      | enum          | APPLICATION_CREATED, APPLICATION_UPDATED, APPLICATION_SUBMITTED, REVIEWER_ASSIGNED, OWNERSHIP_TRANSFERRED, KYB_CHECK_ATTEMPT_FAILED, KYB_CHECK_COMPLETED, KYB_CHECK_FAILED, DECISION_RECORDED, LOGIN_SUCCEEDED, LOGIN_FAILED |
| entity_type | varchar       | `merchant_application`, `user` |
| entity_id   | uuid null     | |
| meta        | jsonb default '{}' | **masked** before insert (changed fields, from/to status, decision) |
| created_at  | timestamptz   | |

Index `(entity_type, entity_id, created_at)`. The audit row is written **in the same transaction**
as the change it describes, so an action cannot succeed without an audit record.

Append-only is enforced by triggers that reject `UPDATE`, `DELETE` and `TRUNCATE` on `audit_logs`.
Test cleanup briefly disables the triggers inside a transaction.
`meta` is redacted, masked and capped at 8 KB. A larger value is stored as
`{ "truncated": true, "originalBytes": <n> }` instead of failing the action.
