# courier-tenant-inbox-test

A Jest suite that exercises the full Courier tenant inbox flow using **only `fetch`** — no SDK.

It walks through these Courier API calls and prints the request + response for each:

1. **Create a user** — `POST https://api.courier.com/profiles/{user_id}` with an email address.
2. **Send** — `POST https://api.courier.com/send` to that `user_id` with `context.tenant_id`.
3. **Message status** — polls `GET https://api.courier.com/messages/{requestId}` until the message leaves the queue (`ENQUEUED → SENT`).
4. **Issue a JWT** — `POST https://api.courier.com/auth/issue-token`, then logs and decodes the token.
5. **Get messages** — `POST https://inbox.courier.com/q` (inbox GraphQL), scoped to the user (JWT + `x-courier-user-id`) and the tenant (passed in the GraphQL `params` as `accountId`, mapped from the tenant like `courier-react` does).

## Requirements

- Node 18+ (uses the built-in global `fetch`). The only dependency is **Jest** (dev) — run `npm install` once.

## Usage

```bash
npm install   # installs Jest (dev dependency)
npm test      # runs the Jest test suite
```

There are two test files, each a set of ordered Jest steps sharing a fresh random `user_id` per run:

- [tenant-delivery.test.js](tenant-delivery.test.js) — the raw flow: create → send → status → tenant-scoped read → non-tenant read.
- [courier-react-parity.test.js](courier-react-parity.test.js) — issues the inbox read **byte-identically to `courier-react`** (query builder, `tenantId → accountId` map, endpoint, JWT + `x-courier-client-key` + `x-courier-client-source-id` headers), then runs it live.

## What you'll see (the tenant-scoping gap)

The message-status call shows the message tagged to the tenant — `accountId: "sample-tenant"` — and routed to the `inbox` channel. But a **tenant-scoped** inbox read returns nothing, while the **same read without a tenant filter** returns the message. That inverts what tenant scoping should do:

| Read | Expected | Actual | Status |
|------|:--------:|:------:|--------|
| Message status (Send pipeline tags the tenant) | `accountId: sample-tenant` | `accountId: sample-tenant` | ✅ pass |
| Tenant-scoped read (`params.accountId = sample-tenant`) — *should* see the tenant's message | `totalCount: 1` | `totalCount: 0` | ❌ **fail (the gap)** |
| Non-tenant read (no `accountId` filter) — *should not* see a tenant-scoped message | `totalCount: 0` | `totalCount: 1` | ❌ **fail (the gap)** |
| `courier-react` parity, `tenantId = sample-tenant` (request shape matches exactly) | `totalCount: 1` | `totalCount: 0` | ❌ **fail (the gap)** |
| `courier-react` parity, no tenant (endpoint/JWT/client-key sanity) | `totalCount: 1` | `totalCount: 1` | ✅ pass |

The tenant-scoped reads fail because the inbox-stored copy persists `accountId: null` (drop the `params.accountId` filter and the same message comes back with `accountId: null`). So even though the Send pipeline associates the message with the tenant at the message level, the inbox ingest doesn't carry `accountId` through for Send-API/template messages — a tenant-scoped read therefore finds nothing, and an unscoped read finds it anyway.

The ❌ rows are intentional **known-failing** assertions: they encode the desired behavior and serve as a regression check for when inbox ingest carries `accountId` through.

## Configuration

The values are hardcoded at the top of [tenant-delivery.test.js](tenant-delivery.test.js):

```js
const API_KEY     = "pk_...";              // Courier API key
const TEMPLATE_ID = "nt_...";              // notification template
const TENANT_ID   = "sample-tenant";       // tenant the send is scoped to
const EMAIL       = "mike@courier.com";    // email added to the created user
```

Edit them in place to point at a different key, template, tenant, or email.
