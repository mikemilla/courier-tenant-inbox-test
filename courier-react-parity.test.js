// courier-react inbox request parity test — uses only `fetch` (no SDK).
//
// Verifies the sample issues the inbox read request EXACTLY as courier-react does,
// then sends it live. The query builder, the tenantId -> accountId mapping, the
// endpoint, and the JWT headers below are copied verbatim from courier-react:
//   - query builder  : packages/client-graphql/src/inbox/messages.ts (messagesProps + createGetInboxMessagesQuery)
//   - tenant mapping  : params.accountId = tenantId   ("[HACK] map tenantId to accountId")
//   - endpoint        : https://inbox.courier.com/q   (packages/client-graphql/src/inbox/index.ts apiUrl override)
//   - JWT headers     : authorization: Bearer <jwt> + x-courier-client-key + x-courier-client-source-id
//   - clientSourceId  : `${jwt.tenant_id}/${scopeUserId}` (packages/react-provider/src/hooks/use-client-source-id.ts)
//
// These steps run in order and share state — each depends on the previous one.
// Run with: npm test  (or: npx jest courier-react-parity.test.js)

const API_KEY = "pk_CRRRYD4XM9MV6MM8VCG66FXJNDH0";
// Public client key courier-react sends as x-courier-client-key (base64 of `${tenantId}/env`).
const CLIENT_KEY = "YTg3MWI1Y2MtMDAzYi00Mzg1LWFlZmQtOWU0YjViNDg1Y2NmL2Vudl8wMWt0YzluZnlxZms0cnc3bnR0M216djY2aA==";
const TEMPLATE_ID = "nt_01ktc9s2gtf6bv471bjp2af1r4";
const TENANT_ID = "sample-tenant";
const EMAIL = "mike@courier.com";
// Inbox endpoint, resolved exactly as the package does:
//   Inbox({ apiUrl: inboxApiUrl })  (react-hooks/src/inbox/use-inbox-actions.ts)
//     -> createCourierClient(params, { apiUrl: "https://inbox.courier.com/q" })  (client-graphql/src/inbox/index.ts:35)
//     -> url = params.apiUrl (inboxApiUrl, undefined by default) || defaults.apiUrl
//   inboxApiUrl has no default in the provider, so the inbox URL is:
const INBOX_API_URL = "https://inbox.courier.com/q";

const J = (o) => JSON.stringify(o, null, 2);

// --- verbatim from courier-react: packages/client-graphql/src/inbox/messages.ts ---
const messagesProps = `
  totalCount
  pageInfo {
    startCursor
    hasNextPage
  }
  nodes {
    actions(version: 2) {
      background_color
      data
      content
      href
      style
    }
    archived
    created
    data
    icon
    messageId
    opened
    pinned {
      slotId
    }
    preview
    read
    icon
    tags
    title
    trackingIds {
      openTrackingId
      archiveTrackingId
      clickTrackingId
      deliverTrackingId
      readTrackingId
      unreadTrackingId
    }
  }
`;

const createGetInboxMessagesQuery = (includePinned) => `
  query GetInboxMessages($params: FilterParamsInput, ${
    includePinned ? "$pinnedParams: FilterParamsInput, " : ""
  } $limit: Int = 10, $after: String){
    ${
      includePinned
        ? `
      pinned: messages(params: $pinnedParams, limit: $limit, after: $after) {
        ${messagesProps}
      }
    `
        : ""
    }
    messages(params: $params, limit: $limit, after: $after) {
      ${messagesProps}
    }
  }
`;
// --- end verbatim ---

// Builds the exact request courier-react's getInboxMessages(params, after) sends.
// Mirrors packages/client-graphql/src/inbox/messages.ts + client.ts (JWT path).
function buildCourierReactRequest({ jwt, decodedJwt, params }) {
  const after = undefined; // first page -> includePinned = !after = true
  const { limit, tenantId, ...restParams } = params ?? {};
  const query = createGetInboxMessagesQuery(!after);
  const variables = {
    after,
    limit,
    // [HACK] map tenantId to accountId in order to keep this backwards compatible
    params: { ...restParams, accountId: tenantId, pinned: false },
    pinnedParams: { ...restParams, pinned: true },
  };

  // clientSourceId, exactly as use-client-source-id.ts computes it.
  const scopeUserId = decodedJwt.scope.split(" ").find((s) => s.includes("user_id")).replace("user_id:", "");
  const clientSourceId = `${decodedJwt.tenant_id}/${scopeUserId}`;

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${jwt}`,
    "x-courier-client-key": CLIENT_KEY,
    "x-courier-client-source-id": clientSourceId,
  };

  const body = JSON.stringify({ query, operationName: "GetInboxMessages", variables });
  return { url: INBOX_API_URL, method: "POST", headers, body, variables, clientSourceId };
}

describe("courier-react inbox request parity", () => {
  // Shared state across the ordered steps. A fresh random user_id per run.
  const userId = `user-and-tenant-${Math.floor(Math.random() * 1e9)}`;
  let requestId;
  let jwt;
  let decodedJwt;

  test("1. creates the user with an email address", async () => {
    console.log(`===== CREATE USER | userId=${userId} =====`);
    const res = await fetch(`https://api.courier.com/profiles/${userId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ profile: { email: EMAIL } }),
    });
    console.log(`CREATE RESPONSE (HTTP ${res.status})`);
    expect(res.status).toBe(200);
  });

  test("2. sends the template to the user with tenant context", async () => {
    const message = { to: { user_id: userId }, context: { tenant_id: TENANT_ID }, template: TEMPLATE_ID };
    console.log(`\n===== SEND | to user_id + tenant (${TENANT_ID}) =====`);
    const res = await fetch("https://api.courier.com/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ message }),
    });
    const json = await res.json();
    console.log(`SEND RESPONSE (HTTP ${res.status}):`, J(json));
    requestId = json.requestId;
    expect(res.status).toBe(202);
    expect(requestId).toEqual(expect.any(String));
  });

  test("3. polls message status until it leaves the queue", async () => {
    console.log(`\n===== MESSAGE STATUS =====`);
    let statusJson;
    for (let attempt = 1; attempt <= 15; attempt++) {
      const res = await fetch(`https://api.courier.com/messages/${requestId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      statusJson = await res.json();
      console.log(`  attempt ${attempt}: HTTP ${res.status} status=${statusJson.status} accountId=${statusJson.accountId}`);
      if (["SENT", "DELIVERED", "OPENED", "CLICKED"].includes(statusJson.status)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(["SENT", "DELIVERED", "OPENED", "CLICKED"]).toContain(statusJson.status);
    // The message is tagged to the tenant at the message level.
    expect(statusJson.accountId).toBe(TENANT_ID);
  }, 60_000);

  test("4. issues a JWT scoped to the user (the scopes courier-react expects)", async () => {
    const scope = [`user_id:${userId}`, "inbox:read:messages", "inbox:write:events", "read:brands", "read:preferences"].join(" ");
    const res = await fetch("https://api.courier.com/auth/issue-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ scope, expires_in: "1 day" }),
    });
    const json = await res.json();
    jwt = json.token;
    decodedJwt = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    console.log("\n===== JWT (decoded) =====");
    console.log(J(decodedJwt));
    expect(res.status).toBe(200);
    expect(jwt).toEqual(expect.any(String));
  });

  test("5. the read request matches courier-react exactly (and runs live)", async () => {
    // Allow OpenSearch a moment to index the inbox copy.
    await new Promise((r) => setTimeout(r, 6000));

    const req = buildCourierReactRequest({ jwt, decodedJwt, params: { tenantId: TENANT_ID } });

    console.log(`\n===== GET MESSAGES [courier-react request, tenantId=${TENANT_ID}] =====`);
    console.log("POST", req.url);
    console.log("headers:", J({ ...req.headers, authorization: "Bearer <jwt>" }));
    console.log("body:", req.body);

    // --- assert the request is byte-shaped like courier-react's ---
    expect(req.url).toBe("https://inbox.courier.com/q");
    expect(req.headers["x-courier-client-key"]).toBe(CLIENT_KEY);
    expect(req.headers["x-courier-client-source-id"]).toBe(`${decodedJwt.tenant_id}/${userId}`);
    expect(req.headers.authorization).toBe(`Bearer ${jwt}`);
    // tenantId is carried on the request as params.accountId; the main list excludes pinned.
    expect(req.variables.params).toEqual({ accountId: TENANT_ID, pinned: false });
    expect(req.variables.pinnedParams).toEqual({ pinned: true });
    expect(JSON.parse(req.body).operationName).toBe("GetInboxMessages");
    expect(JSON.parse(req.body).query).toBe(createGetInboxMessagesQuery(true));

    // --- send it live ---
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    const json = await res.json();
    console.log(`RESPONSE (HTTP ${res.status}):`, J(json));
    const totalCount = json?.data?.messages?.totalCount;
    console.log(`\ncourier-react request, tenantId=${TENANT_ID} -> message count = ${totalCount}`);

    expect(res.status).toBe(200);
    // KNOWN-FAILING (desired behavior): the tenant-scoped read should return the user's
    // tenant message (1). Today it returns 0 because the inbox-stored copy persists
    // accountId: null, so the params.accountId filter matches nothing. Regression check
    // for when inbox ingest carries accountId through (backend/providers/courier/send.ts).
    expect(totalCount).toBe(1);
  }, 30_000);

  test("6. same courier-react request without a tenant returns the message (endpoint/auth sanity)", async () => {
    const req = buildCourierReactRequest({ jwt, decodedJwt, params: {} });
    expect(req.variables.params).toEqual({ accountId: undefined, pinned: false });

    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    const json = await res.json();
    const totalCount = json?.data?.messages?.totalCount;
    console.log(`\ncourier-react request, no tenant -> message count = ${totalCount}`);

    expect(res.status).toBe(200);
    // Proves the endpoint + JWT + client-key path all work: with no account filter the
    // message is found (stored with accountId: null). Isolates the gap to the tenant tag.
    expect(totalCount).toBe(1);
  }, 30_000);
});
