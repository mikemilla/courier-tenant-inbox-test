---
name: tenant-inbox-tests
description: Run and interpret the Courier tenant-inbox integration suite (tenant-inbox.test.js). Use when the user wants to run the tenant inbox tests, see the expected results per environment (dev/prod), or check whether a run matches the known baseline.
---

# Tenant inbox tests

[tenant-inbox.test.js](../../../tenant-inbox.test.js) is a single fetch-only Jest
file that runs the **same scenarios against both `dev` and `prod`** in one go. The
expectations are **identical in every environment on purpose** — they encode the
*desired* behavior — so the pass/fail pattern itself tells you what each environment
does and does not yet support.

The suite covers scenarios **A–E** (tenant scoping) plus a feature surface
(read/unread, archive, pagination, invalid-JWT).

## How to run

```bash
npm install                 # once — installs Jest (Node 18+)
npm test                    # both envs, live API calls (~3–4 min)
COURIER_ENVS=dev npm test   # scope to one env
COURIER_ENVS=prod npm test
```

These hit live Courier APIs (create user, send, poll status, issue JWT, read inbox),
so a full run takes a few minutes.

## Expected results (the baseline)

| Scenario | Sent to | Read with | Expect | dev | prod |
|---|---|---|:--:|:--:|:--:|
| **A** | user_id, tagged with tenant | tenant + user | `1` | ✅ | ❌ (`0`) |
| **B** | user_id, no tenant | tenant + user | `0` | ✅ | ✅ |
| **C** | tenant broadcast (no user_id) | tenant + user | `1` | ✅ | ❌ (`0`) |
| **D** | tenant broadcast (no user_id) | user only (no tenant) | `0` | ❌ (`1`) | ❌ (`1`) |
| **E** | non-existent tenant broadcast | tenant+user & user only | `0` / `0` | ✅ | ✅ |
| read / unread | no-tenant path | — | read state toggles | ✅ | ✅ |
| archive | no-tenant path | — | leaves default list | ✅ | ✅ |
| pagination | no-tenant path | — | `limit`+`after` cursor walks | ✅ | ✅ |
| invalid-JWT | — | — | HTTP 403 / no data | ✅ | ✅ |

**Baseline totals: 18 tests → 14 pass, 4 fail.** `dev` fails only **D**; `prod`
fails **A, C, D**. Those 4 failures are **green-by-design** — they are known and
expected, not regressions.

## Why the 4 failures are expected

- **A & C fail on `prod` only.** The `accountId`-ingest fix (backend branch
  `mike/c-inbox-tenant-accountid-ingest`) is deployed to **dev only**. On prod the
  inbox copy still persists `accountId: null`, so a tenant-scoped read (`params.accountId`)
  matches nothing and returns `0` instead of `1`.
- **D fails in both envs.** An untenanted read excludes tenant-scoped messages only
  when the inbox provider's `tenantFiltering` is **on**. It is **off** in both envs,
  so a tenant broadcast is still visible to a user-only read (`1` instead of `0`).

## What to report when this skill is invoked

1. Run the suite (`npm test`, or honor a `COURIER_ENVS` the user gave).
2. From the output, capture each scenario's `... read = N` log line and the final
   `Tests: …` summary line (per-env logs are prefixed `[dev]` / `[prod]`).
3. Present an **expected-vs-actual table per environment** using the baseline above.
4. Call out the result clearly:
   - Matches baseline (14 pass / 4 fail, dev→D, prod→A/C/D) → **as expected**, note
     the 4 are known/expected failures.
   - **Any other deviation** (a baseline-pass test failing, or a known-fail test
     newly passing) → flag it as a **real change/regression** and say which env +
     scenario, with the actual vs expected count.
