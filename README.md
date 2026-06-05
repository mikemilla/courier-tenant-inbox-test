# courier-tenant-inbox-test

A Jest suite that exercises the full Courier tenant inbox flow using **only `fetch`** — no SDK.

It walks the Courier API end-to-end and asserts the central question: **a message sent to a `user_id` within a tenant should be visible to a tenant-scoped inbox read, and a message sent without a tenant should not.**

The inbox is always read **with a tenant** (`params.accountId = tenantId`, exactly the way `courier-react` reads in a tenanted app — it maps its `tenantId` prop to `accountId`). What varies per scenario is **how the message was sent**:

| Scenario | Sent to… | Read with… | Should see it? |
|----------|----------|------------|:--------------:|
| **A** | user_id, tagged with tenant | tenant + user_id | **yes** (`totalCount: 1`) |
| **B** | user_id, no tenant | tenant + user_id | **no** (`totalCount: 0`) |
| **C** | tenant broadcast (no user_id) | tenant + user_id | **yes** (`totalCount: 1`) |
| **D** | tenant broadcast (no user_id) | user_id only (no tenant) | **no** (`totalCount: 0`) |

Scenarios C/D send to a whole tenant (`to: { tenant_id }`, no `user_id`); the receiving user is a tenant member (`PUT /users/{id}/tenants/{tenant}`).

## Environment

All config lives in [courier-helpers.js](courier-helpers.js) and **defaults to the shared DEV environment**. Override per-run with env vars:

| Var | Default (dev) |
|-----|---------------|
| `COURIER_ENV` | `dev` (set `prod` for production) |
| `COURIER_API_URL` | `https://1m5q00wehc…/dev` (Client REST) |
| `COURIER_INBOX_URL` | `https://hfyaspnct6…/dev/q` (Inbox GraphQL) |
| `COURIER_API_KEY`, `COURIER_TEMPLATE_ID`, `COURIER_TENANT_ID`, `COURIER_EMAIL` | dev workspace values |

## Requirements

- Node 18+ (built-in `fetch`). The only dependency is **Jest** (dev) — run `npm install` once.

## Usage

```bash
npm install
npm test                 # runs the full suite against shared dev
COURIER_ENV=prod npm test   # run against production instead
```

## Test files

- [tenant-inbox.test.js](tenant-inbox.test.js) — the whole suite, one file:
  - **Scenario A** — create → send WITH tenant → status → tenant+user read sees it (`1`).
  - **Scenario B** — same flow sent WITHOUT a tenant → tenant+user read does not see it (`0`).
  - **Scenario C** — broadcast to the tenant (no user_id) → tenant+user read sees it (`1`).
  - **Scenario D** — broadcast to the tenant (no user_id) → user-only read (no tenant) does not see it (`0`).
  - **Feature surface** (no-tenant path): read/unread, archive, pagination (`limit` + `after`/`pageInfo`), and invalid-JWT rejection.
- [courier-helpers.js](courier-helpers.js) — shared config + helpers (`createUser`, `send`, `pollStatus`, `userJwt`, `readInbox`, `inboxTrack`), grounded in `@trycourier/courier-js`.

## Status

Latest run against shared dev: **7 of 8 passed.** Scenarios A, B, **C**, and the four feature tests pass; **scenario D fails** (read count = 1, expected 0) — see the `tenantFiltering` note below.

Scenario A was the original failure (now fixed). The message was tagged to the tenant at the message level, but the **inbox-stored copy persisted `accountId: null`**, so the `params.accountId` filter matched nothing. Root cause and fix (backend branch `mike/c-inbox-tenant-accountid-ingest`):

This previously failed scenario A: the message was tagged to the tenant at the message level, but the **inbox-stored copy persisted `accountId: null`**, so the `params.accountId` filter matched nothing. Root cause and fix (backend branch `mike/c-inbox-tenant-accountid-ingest`):

1. The send context's `accountId` was sourced only from the resolved **account object** (`account?.accountId`), which is `null` when the tenant isn't materialized as an account object — even though the message carries `context.tenant_id`. Fixed by falling back to the customer tenant id and threading `context.accountId` through `DeliveryHandlerParams` into the inbox send ([prepare-from-template-message.ts](../backend/send/worker/commands/prepare/prepare-from-template-message.ts), [prepare-from-content-message.ts](../backend/send/worker/commands/prepare/prepare-from-content-message.ts), [get-delivery-handler-params.ts](../backend/send/worker/provider-render/get-delivery-handler-params.ts), [providers/types.ts](../backend/providers/types.ts)).
2. [providers/courier/send.ts](../backend/providers/courier/send.ts) gated the modern `sendV2` (`/inbox`, which forwards `accountId`) on `taxonomy === "inbox:courier"`, but inbox channels render with a wildcard taxonomy (`inbox:*`), so inbox sends fell to the legacy `sendV1` (`/send`) path that drops `accountId`. Fixed to match `taxonomy.includes("inbox")`.

Deployed to shared dev: `ActionWorker`, `ProviderRenderStreamWorker`, `ProviderSendStreamWorker`.

> **Scenario D and the `tenantFiltering` contract.** D asserts that an **untenanted read** (no `accountId`) does *not* surface tenant-scoped messages. That contract depends on the workspace's inbox provider `tenantFiltering` config, which is **off** on shared dev — so an untenanted read currently returns all of a user's messages including tenant-scoped ones, and D reads back `1` instead of `0`. D is kept as a **known-failing** regression check encoding the desired contract; it will pass once `tenantFiltering` is enabled on the workspace's inbox provider.
