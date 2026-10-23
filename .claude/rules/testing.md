---
paths:
  - "test/**"
  - "src/**/*.spec.ts"
---

# Testing rules

- Tests are deterministic. Use a fake `KybProvider` and no real randomness or fixed sleeps:
  poll for the expected state, with a timeout.
- Every authz rule needs a test that proves the **denied** case. The required cases are listed in
  docs/adrs/testing.md.
- Test credentials come from env or obviously fake constants, never real-looking secrets.
