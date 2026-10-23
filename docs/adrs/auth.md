# Auth details

- `POST /auth/login` returns `{ accessToken, expiresIn }`. JWTs are HS256, signed with a secret from
  env, expire after 1h, and carry the claims `{ sub, role }`.
- _(trade-off)_ There are no refresh tokens or revocation list. For a production system I'd add
  short-lived access tokens, rotating refresh tokens and a token version on the user.
- Login failures return a generic `401 Invalid credentials` (this prevents user enumeration).
  bcrypt `compare` runs even when the user doesn't exist, which keeps response timing similar.
- Every failed login writes a `LOGIN_FAILED` audit row with the email masked.


# Authorization

Authorization has two layers:

1. **Role guard** (`@Roles(...)`): coarse checks. A request from the wrong role gets **403**.
   Revealing that "SALES can't assign" leaks nothing.
2. **Scoped data access**: every read/write goes through
   `applicationsRepo.findAccessible(id, actor)`. That function adds
   `sales_owner_id = actor.id` for SALES and `assigned_reviewer_id = actor.id` for REVIEWER. A row
   outside the actor's scope gets **404**, the same as an ID that doesn't exist.
   _(trade-off)_ 404 hides whether the ID exists, so callers cannot probe for other users'
   applications. The cost is a less precise error: a client can't tell "not yours" from "not
   found". A 403 would be clearer, but it would confirm that the ID exists.

The services have no unscoped "find by ID" path for user requests. That is the main defence
against bypass, because a forgotten `if` in a controller cannot leak data.

| Endpoint                          | ADMIN | REVIEWER          | SALES      |
|-----------------------------------|-------|-------------------|------------|
| `POST /auth/login`                | public | public           | public     |
| `POST /applications`              | ✓ (`salesOwnerId` required) | 403 | ✓ (owner = self; `salesOwnerId` not accepted) |
| `GET /applications?status&page&limit` | all | assigned to self | own only   |
| `GET /applications/:id`           | ✓     | if assigned       | if owner   |
| `PATCH /applications/:id`         | ✓     | 403               | if owner   |
| `POST /applications/:id/submit`   | ✓     | 403               | if owner   |
| `POST /applications/:id/assign`   | ✓     | 403               | 403        |
| `POST /applications/:id/transfer-owner` | ✓ | 403          | 403        |
| `POST /applications/:id/decision` | 403   | if assigned       | 403        |
| `GET /applications/:id/audit-logs`| ✓     | 403               | 403        |

**REVIEWERs see only applications assigned to them** (least privilege). Since ADMIN
does the assigning, a reviewer has no need to browse the unassigned pool.

DTOs use a whitelist (`whitelist: true, forbidNonWhitelisted: true`). Because of that, fields such
as `createdById`, `status`, `kybStatus`, `kybLevel` or `assignedReviewerId` cannot be set through
create/update payloads (this blocks mass assignment). `salesOwnerId` is accepted on create only
from ADMIN; if SALES sends it, the request is rejected with 403, so SALES can't create an
application on someone else's behalf. After creation, `salesOwnerId` changes only through the
ADMIN transfer endpoint.

Concurrency: transitions run with the optimistic `version` column, or with
`UPDATE ... WHERE status = :expected`. When two simultaneous decisions arrive, one wins and the
other gets 409.

---