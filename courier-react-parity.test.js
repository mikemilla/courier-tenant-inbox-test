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
// The inbox is always read WITH a tenant (params.accountId = tenantId). What varies
// is how the message was SENT:
//   A. Sent WITH tenant + user_id  -> the tenant read SHOULD see it    (1)
//   B. Sent WITHOUT tenant (user_id only) -> the tenant read should NOT see it (0)
// Each scenario uses its own fresh user so the two don't cross-contaminate.
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

// --- shared flow helpers ---
async function createUser(userId) {
  const res = await fetch(`https://api.courier.com/profiles/${userId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ profile: { email: EMAIL } }),
  });
  console.log(`CREATE USER ${userId} -> HTTP ${res.status}`);
  if (res.status !== 200) throw new Error(`create user failed: HTTP ${res.status}`);
}

async function send(userId, withTenant) {
  const message = {
    to: { user_id: userId },
    template: TEMPLATE_ID,
    ...(withTenant ? { context: { tenant_id: TENANT_ID } } : {}),
  };
  const res = await fetch("https://api.courier.com/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ message }),
  });
  const json = await res.json();
  console.log(`SEND (withTenant=${withTenant}) -> HTTP ${res.status}`, J(json));
  if (res.status !== 202) throw new Error(`send failed: HTTP ${res.status}`);
  return json.requestId;
}

async function pollStatus(requestId) {
  let statusJson;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const res = await fetch(`https://api.courier.com/messages/${requestId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    statusJson = await res.json();
    console.log(`  status attempt ${attempt}: HTTP ${res.status} status=${statusJson.status} accountId=${statusJson.accountId}`);
    if (["SENT", "DELIVERED", "OPENED", "CLICKED"].includes(statusJson.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return statusJson;
}

async function issueUserJwt(userId) {
  const scope = [`user_id:${userId}`, "inbox:read:messages", "inbox:write:events", "read:brands", "read:preferences"].join(" ");
  const res = await fetch("https://api.courier.com/auth/issue-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ scope, expires_in: "1 day" }),
  });
  const { token } = await res.json();
  const decoded = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  return { jwt: token, decodedJwt: decoded };
}

// Sends (with/without tenant) then reads the inbox WITH a tenant, using the exact
// courier-react request. Returns the live tenant read result + the built request
// so the caller can assert request-shape parity.
async function runScenario(withTenant) {
  const userId = `user-and-tenant-${Math.floor(Math.random() * 1e9)}`;
  console.log(`\n===== SCENARIO sent ${withTenant ? "WITH" : "WITHOUT"} tenant | userId=${userId} =====`);
  await createUser(userId);
  const requestId = await send(userId, withTenant);
  const status = await pollStatus(requestId);
  await new Promise((r) => setTimeout(r, 6000)); // let OpenSearch index the inbox copy
  const { jwt, decodedJwt } = await issueUserJwt(userId);

  const req = buildCourierReactRequest({ jwt, decodedJwt, params: { tenantId: TENANT_ID } });
  console.log(`GET MESSAGES [courier-react request, tenantId=${TENANT_ID}] POST ${req.url}`);
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const json = await res.json();
  const totalCount = json?.data?.messages?.totalCount;
  console.log(`RESULT: sent ${withTenant ? "WITH" : "WITHOUT"} tenant -> courier-react tenant read count = ${totalCount}`);
  return { userId, status, req, decodedJwt, jwt, readStatus: res.status, totalCount };
}

describe("courier-react inbox request parity & tenant scoping", () => {
  test("A. a message sent WITH tenant is visible to the courier-react tenant read (and the request matches exactly)", async () => {
    const r = await runScenario(true);

    // --- assert the request is byte-shaped like courier-react's ---
    expect(r.req.url).toBe("https://inbox.courier.com/q");
    expect(r.req.headers["x-courier-client-key"]).toBe(CLIENT_KEY);
    expect(r.req.headers["x-courier-client-source-id"]).toBe(`${r.decodedJwt.tenant_id}/${r.userId}`);
    expect(r.req.headers.authorization).toBe(`Bearer ${r.jwt}`);
    expect(r.req.variables.params).toEqual({ accountId: TENANT_ID, pinned: false });
    expect(r.req.variables.pinnedParams).toEqual({ pinned: true });
    expect(JSON.parse(r.req.body).operationName).toBe("GetInboxMessages");
    expect(JSON.parse(r.req.body).query).toBe(createGetInboxMessagesQuery(true));

    // --- live behavior ---
    expect(r.readStatus).toBe(200);
    // DESIRED: a tenant read sees the tenant-scoped message.
    expect(r.totalCount).toBe(1);
  }, 90_000);

  test("B. a message sent WITHOUT tenant is NOT visible to the courier-react tenant read", async () => {
    const r = await runScenario(false);
    expect(r.readStatus).toBe(200);
    // DESIRED: a tenant read does NOT see a message that was sent without a tenant.
    expect(r.totalCount).toBe(0);
  }, 90_000);
});
