# courier-tenant-inbox-test

A fetch-only Jest suite ([tenant-inbox.test.js](tenant-inbox.test.js)) that runs the same tenant-inbox scenarios against **dev and prod** in one go. Run with `npm test` (or `COURIER_ENVS=dev|prod npm test`).

## Running the examples

Two runnable demos exercise the **same** send-with-tenant → read flow through the real Courier SDKs. Both default to **dev** (which has the `accountId`-ingest fix) and reuse the suite's template/tenant.

**[courier-js-sdk-demo/](courier-js-sdk-demo/)** — a Node script that sends to a `user_id` tagged with the tenant, then reads the inbox through `@trycourier/courier-js`'s `CourierClient.inbox.getMessages()` twice: once **with** a tenant (`new CourierClient({ ..., tenantId })`, mapped to `params.accountId`) and once **without**.

```bash
cd courier-js-sdk-demo
npm install
npm start            # COURIER_ENV=prod npm start to hit prod
```

**[react-inbox-app/](react-inbox-app/)** — a Vite + React (TypeScript) app rendering the same flow with `@trycourier/courier-react`'s `<CourierInbox/>`. It signs in `mike` with a hardcoded client JWT and a checkbox toggles whether `signIn()` passes `tenantId` (tenant-scoped vs unscoped read). `mike`'s inbox is pre-seeded with 3 tenant-tagged + 5 untenanted messages, so the toggle shows 3 (tenant on) vs all 8 (tenant off).

```bash
cd react-inbox-app
npm install
npm run dev          # http://localhost:5174
```

## The issue

A message sent to a `user_id` **within a tenant** was not visible to a tenant-scoped inbox read. The message was tagged to the tenant at the message level (`status.accountId = "sample-tenant"`), but the **inbox-stored copy persisted `accountId: null`** — so a read filtering on `params.accountId` (the way `courier-react` reads, mapping its `tenantId` prop to `accountId`) matched nothing and returned zero messages.

## The solution

Two backend fixes (branch `mike/c-inbox-tenant-accountid-ingest`), **deployed to dev** (not yet prod):

1. The send context's `accountId` was sourced only from the resolved account object (`account?.accountId`), which is `null` when the tenant isn't materialized as an account object — even though the message carries `context.tenant_id`. Fixed to fall back to the customer tenant id and thread `context.accountId` through `DeliveryHandlerParams` into the inbox send.
2. `providers/courier/send.ts` gated the modern `sendV2` (`/inbox`, which forwards `accountId`) on `taxonomy === "inbox:courier"`, but inbox channels render with a wildcard taxonomy (`inbox:*`), so inbox sends fell back to the legacy `sendV1` (`/send`) path that drops `accountId`. Fixed to match `taxonomy.includes("inbox")`.

One scenario (**D**) remains: an untenanted read excludes tenant-scoped messages only when the inbox provider's `tenantFiltering` is enabled — it is **off** in both envs.

## Test scenarios

Expectations are identical per env (they encode the desired behavior). dev has the fix; prod does not.

| # | Scenario | Expected | Dev | Prod |
|---|----------|:--------:|:---:|:----:|
| A | Send to user_id tagged with tenant → read with tenant + user_id | `1` | ✅ `1` | ❌ `0` |
| B | Send to user_id with no tenant → read with tenant + user_id | `0` | ✅ `0` | ✅ `0` |
| C | Broadcast to tenant (no user_id) → read with tenant + user_id | `1` | ✅ `1` | ❌ `0` |
| D | Broadcast to tenant (no user_id) → read with user_id only (no tenant) | `0` | ❌ `≥1` | ❌ `≥1` |
| E | Broadcast to a non-existent tenant → read with tenant+user and user-only | `0` / `0` | ✅ `0`/`0` | ✅ `0`/`0` |
| F | read / unread mutation toggles read state + `status` filter | toggles | ✅ | ✅ |
| G | archive removes from default list, shows under `archived:true` | archived | ✅ | ✅ |
| H | pagination — `limit` + `after` cursor walks the list | walks | ✅ | ✅ |
| I | invalid JWT is rejected | HTTP 403 | ✅ | ✅ |

**Totals: 18 tests → 14 pass, 4 fail.** dev fails only **D**; prod fails **A, C, D**. All four are expected: A/C fail on prod because the fix is dev-only; D fails in both because `tenantFiltering` is off.
