# courier-tenant-inbox-test

A Jest suite that exercises the full Courier tenant inbox flow using **only `fetch`** — no SDK.

Each scenario walks through these Courier API calls and prints the request + response for each:

1. **Create a user** — `POST https://api.courier.com/profiles/{user_id}` with an email address.
2. **Send** — `POST https://api.courier.com/send` to that `user_id`, with `context.tenant_id` (scenario A) or without it (scenario B).
3. **Message status** — polls `GET https://api.courier.com/messages/{requestId}` until the message leaves the queue (`ENQUEUED → SENT`).
4. **Issue a JWT** — `POST https://api.courier.com/auth/issue-token` for the user.
5. **Get messages** — `POST https://inbox.courier.com/q` (inbox GraphQL), read with the tenant + user_id (the tenant passed in the GraphQL `params` as `accountId`, mapped from the tenant like `courier-react` does).

## Requirements

- Node 18+ (uses the built-in global `fetch`). The only dependency is **Jest** (dev) — run `npm install` once.

## Usage

```bash
npm install   # installs Jest (dev dependency)
npm test      # runs the Jest test suite
```

The two **core** files cover the central question — each always **reads the inbox with a tenant + user_id** (`params.accountId = tenantId`, the way `courier-react` reads in a tenanted app) and varies **how the message was sent**. Each scenario uses its own fresh random `user_id`:

- [tenant-delivery.test.js](tenant-delivery.test.js) — the raw flow (create → send → status → tenant+user read).
- [courier-react-parity.test.js](courier-react-parity.test.js) — same flow, but issues the inbox read **byte-identically to `courier-react`** (query builder, `tenantId → accountId` map, endpoint, JWT + `x-courier-client-key` + `x-courier-client-source-id` headers) and runs it live.

Four more files broaden coverage (isolation, send-path diagnostics, read completeness, feature surface) — see [Additional coverage](#additional-coverage) below.

## Expected behavior

| Scenario | Sent with… | Read with… | Should see it? |
|----------|------------|------------|:--------------:|
| **A** | tenant + user_id | tenant + user_id | **yes** (`totalCount: 1`) |
| **B** | user_id only (no tenant) | tenant + user_id | **no** (`totalCount: 0`) |

A tenant inbox should show messages addressed to that tenant, and should not show messages that were sent without one.

## What you'll see (the tenant-scoping gap)

Latest run (`npm test`, 2026-06-05) — **2 passed, 2 failed (4 total)**:

| Scenario | Expected | Actual | Status |
|----------|:--------:|:------:|--------|
| **A** — sent WITH tenant → tenant+user read *should* see it | `totalCount: 1` | `totalCount: 0` | ❌ **fail (the gap)** |
| **B** — sent WITHOUT tenant → tenant+user read should *not* see it | `totalCount: 0` | `totalCount: 0` | ✅ pass |

Both test files agree (one A + one B each → 2 fail, 2 pass).

The message-status poll confirms scenario A's message **is** tagged to the tenant at the message level (`accountId: "sample-tenant"`). But the tenant+user read still returns `0`, because the **inbox-stored copy persists `accountId: null`** — so the `params.accountId = sample-tenant` filter matches nothing. (Scenario B happens to pass for the same underlying reason: its message also stores `accountId: null`, and the tenant filter correctly excludes it.)

So the Send pipeline associates the message with the tenant, but **inbox ingest doesn't carry `accountId` through** for Send-API/template messages. Scenario A is an intentional **known-failing** assertion — it encodes the desired behavior and serves as a regression check for when inbox ingest propagates `accountId`.

## Additional coverage

Beyond the two core scenarios above, the suite covers the wider tenant-inbox contract. Shared helpers live in [courier-helpers.js](courier-helpers.js) (grounded in `@trycourier/courier-js`: the inbox read query, the `read`/`unread`/`archive` `TrackEvent` mutations, the `FilterParamsInput` fields, and the headers).

### Isolation — the core tenant guarantee · [tenant-isolation.test.js](tenant-isolation.test.js)

| # | Scenario | Expected |
|---|----------|:--------:|
| 1 | Sent to tenant **T1**, read with tenant **T2** | `0` — no cross-tenant leak |
| 2 | Sent to **userA** + tenant, read as **userB** + tenant | `0` — user isolation |
| 3 | userA's JWT but `x-courier-user-id: userB` | no rows returned — header can't override the JWT |

These assert the *negative* (must not leak). They pass today partly because of the `accountId: null` ingest gap, but remain the correct guards once that gap is fixed.

### Send-path diagnostic · [send-paths.test.js](send-paths.test.js)

Probes whether **any** way of tagging the tenant at send time persists `accountId` on the inbox copy — `context.tenant_id`, `to.tenant_id`, and user→tenant **membership** (`PUT /users/{id}/tenants/{tenant}`). For each it reports `status.accountId`, the **stored** `node.accountId` (read with no filter), and the tenant read count. If any path stores a non-null `accountId`, that's the fix/workaround for the gap.

### Read completeness · [inbox-completeness.test.js](inbox-completeness.test.js)

| # | Scenario | Expected | Note |
|---|----------|:--------:|------|
| 4 | Sent WITH tenant, read with **no** tenant filter | `0` | Chosen contract: an untenanted read excludes tenant messages. Known-failing today (returns 1). |
| 5 | **2** messages to one user + tenant, tenant read | `2` | Counting. Known-failing today (returns 0). |
| 6 | One user in **two** tenants, read each | `1` each, only its own | Known-failing today (returns 0). |

### Feature surface · [inbox-features.test.js](inbox-features.test.js)

Exercised on the **working** (no-tenant) path so they're independent of the scoping gap:

- **read / unread** — `TrackEvent` `read`/`unread` mutation toggles `node.read` and the `status: read|unread` filter.
- **archive** — archived messages leave the default list and appear under `params.archived: true`.
- **pagination** — `limit` + `after` cursor walks the list via `pageInfo.startCursor` / `hasNextPage`.
- **auth** — an invalid JWT returns no rows (rejected).

> The tenant-positive cases (#4–6, isolation post-fix) are **known-failing** regression checks tied to the same `accountId` ingest gap; the feature and isolation-negative cases are expected to pass. Run `npm test` for the current live results.

## Configuration

The values are hardcoded at the top of [tenant-delivery.test.js](tenant-delivery.test.js):

```js
const API_KEY     = "pk_...";              // Courier API key
const TEMPLATE_ID = "nt_...";              // notification template
const TENANT_ID   = "sample-tenant";       // tenant the send is scoped to
const EMAIL       = "mike@courier.com";    // email added to the created user
```

Edit them in place to point at a different key, template, tenant, or email.
