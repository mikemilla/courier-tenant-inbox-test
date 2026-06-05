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

There are two test files. Each always **reads the inbox with a tenant + user_id** (`params.accountId = tenantId`, the way `courier-react` reads in a tenanted app) and varies **how the message was sent**. Each scenario uses its own fresh random `user_id`:

- [tenant-delivery.test.js](tenant-delivery.test.js) — the raw flow (create → send → status → tenant+user read).
- [courier-react-parity.test.js](courier-react-parity.test.js) — same flow, but issues the inbox read **byte-identically to `courier-react`** (query builder, `tenantId → accountId` map, endpoint, JWT + `x-courier-client-key` + `x-courier-client-source-id` headers) and runs it live.

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

## Configuration

The values are hardcoded at the top of [tenant-delivery.test.js](tenant-delivery.test.js):

```js
const API_KEY     = "pk_...";              // Courier API key
const TEMPLATE_ID = "nt_...";              // notification template
const TENANT_ID   = "sample-tenant";       // tenant the send is scoped to
const EMAIL       = "mike@courier.com";    // email added to the created user
```

Edit them in place to point at a different key, template, tenant, or email.
