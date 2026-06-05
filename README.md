# courier-tenant-inbox-test

A single, dependency-free Node script that exercises the full Courier tenant inbox flow using **only `fetch`** — no SDK.

It walks through five Courier API calls and prints the request + response for each:

1. **Create a user** — `POST https://api.courier.com/profiles/{user_id}` with an email address.
2. **Send** — `POST https://api.courier.com/send` to that `user_id` with `context.tenant_id`.
3. **Message status** — polls `GET https://api.courier.com/messages/{requestId}` until the message leaves the queue (`ENQUEUED → SENT`).
4. **Issue a JWT** — `POST https://api.courier.com/auth/issue-token`, then logs and decodes the token.
5. **Get messages** — `POST https://inbox.courier.com/q` (inbox GraphQL), scoped to the user (JWT + `x-courier-user-id`) and the tenant (passed in the GraphQL `params` as `accountId`, mapped from the tenant like `courier-react` does).

## Requirements

- Node 18+ (uses the built-in global `fetch`). There are **no dependencies** — `npm install` isn't needed.

## Usage

```bash
npm test
```

(or run it directly: `node tenant-delivery-test.js`)

Each run uses a fresh random `user_id`.

## What you'll see (the tenant-scoping gap)

The message-status call (step 3) shows the message tagged to the tenant — `accountId: "sample-tenant"` — and routed to the `inbox` channel. But the tenant-scoped inbox read (step 5) returns:

```json
{ "data": { "messages": { "totalCount": 0, "nodes": [] } } }
```

That's because the inbox-stored copy persists `accountId: null` (drop the `params.accountId` filter and the same message comes back with `accountId: null`). So even though the Send pipeline associates the message with the tenant at the message level, the inbox ingest doesn't carry `accountId` through for Send-API/template messages — and a tenant-scoped read therefore finds nothing.

## Configuration

The values are hardcoded at the top of [tenant-delivery-test.js](tenant-delivery-test.js):

```js
const API_KEY     = "pk_...";              // Courier API key
const TEMPLATE_ID = "nt_...";              // notification template
const TENANT_ID   = "sample-tenant";       // tenant the send is scoped to
const EMAIL       = "mike@courier.com";    // email added to the created user
```

Edit them in place to point at a different key, template, tenant, or email.
