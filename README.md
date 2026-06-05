# courier-tenant-inbox-test

A single, dependency-free Node script that exercises the full Courier tenant inbox flow using **only `fetch`** — no SDK.

It walks through four Courier API calls and prints the request + response for each:

1. **Create a user** — `POST https://api.courier.com/profiles/{user_id}` with an email address.
2. **Send** — `POST https://api.courier.com/send` to that `user_id` with `context.tenant_id`.
3. **Issue a JWT** — `POST https://api.courier.com/auth/issue-token`, then logs and decodes the token.
4. **Get messages** — `POST https://inbox.courier.com/q` (inbox GraphQL) for that user.

## Requirements

- Node 18+ (uses the built-in global `fetch`). There are **no dependencies** — `npm install` isn't needed.

## Usage

```bash
npm run delivery-test
```

(or run it directly: `node tenant-delivery-test.js`)

Each run uses a fresh random `user_id`, so you'll see the sent message show up in step 4 (`totalCount: 1`).

## Configuration

The values are hardcoded at the top of [tenant-delivery-test.js](tenant-delivery-test.js):

```js
const API_KEY     = "pk_...";              // Courier API key
const TEMPLATE_ID = "nt_...";              // notification template
const TENANT_ID   = "sample-tenant";       // tenant the send is scoped to
const EMAIL       = "mike@courier.com";    // email added to the created user
```

Edit them in place to point at a different key, template, tenant, or email.
