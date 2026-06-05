// Courier tenant inbox delivery test — uses only `fetch` (no SDK).
//
// Integration test exercising the full Courier tenant inbox flow as ordered Jest steps:
// 1. Creates a user via the Courier API with an email address.
// 2. Sends the template to that user_id with tenant context.
// 3. Polls the Messages API until the message leaves the queue.
// 4. Issues a JWT for the user (tenant-scoped and non-tenant) and fetches the inbox.
//
// These steps run in order and share state — each depends on the previous one.
// Run with: npm test

const API_KEY = "pk_CRRRYD4XM9MV6MM8VCG66FXJNDH0";
const TEMPLATE_ID = "nt_01ktc9s2gtf6bv471bjp2af1r4";
const TENANT_ID = "sample-tenant";
const EMAIL = "mike@courier.com";

const J = (o) => JSON.stringify(o, null, 2);

const query = `query GetInboxMessages($params: FilterParamsInput, $limit: Int = 50) {
  messages(params: $params, limit: $limit) {
    totalCount
    nodes { messageId title preview created }
  }
}`;

// Issues a JWT for the given scope, then fetches the inbox. Returns the message
// totalCount. Logs request/response for both calls.
async function issueAndFetch(userId, label, scope) {
  console.log(`\n===== ${label} =====`);
  console.log("ISSUE REQUEST  POST https://api.courier.com/auth/issue-token");
  const tokenBody = { scope, expires_in: "1 day" };
  console.log("body:", J(tokenBody));
  const tokenRes = await fetch("https://api.courier.com/auth/issue-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(tokenBody),
  });
  const { token: jwt } = await tokenRes.json();
  const [, payload] = jwt.split(".");
  console.log(`ISSUE RESPONSE (HTTP ${tokenRes.status}) decoded:`, J(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))));

  const variables = { params: {}, limit: 50 };
  console.log("GET MESSAGES REQUEST  POST https://inbox.courier.com/q");
  console.log("headers:", J({ "x-courier-user-id": userId, Authorization: "Bearer <jwt>" }));
  console.log("body:", J({ query, variables }));
  const inboxRes = await fetch("https://inbox.courier.com/q", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-courier-user-id": userId, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  const inboxJson = await inboxRes.json();
  console.log(`GET MESSAGES RESPONSE  (HTTP ${inboxRes.status}):`, J(inboxJson));
  return { status: inboxRes.status, jwt, totalCount: inboxJson?.data?.messages?.totalCount };
}

describe("Courier tenant inbox delivery flow", () => {
  // Shared state across the ordered steps. A fresh random user_id per run.
  const userId = `user-and-tenant-${Math.floor(Math.random() * 1e9)}`;
  let requestId;
  let statusJson;

  test("1. creates the user with an email address", async () => {
    console.log(`===== CREATE USER | userId=${userId} =====`);
    console.log("CREATE REQUEST  POST https://api.courier.com/profiles/" + userId);
    const createBody = { profile: { email: EMAIL } };
    console.log("body:", J(createBody));
    const createRes = await fetch(`https://api.courier.com/profiles/${userId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(createBody),
    });
    const createJson = await createRes.json();
    console.log(`CREATE RESPONSE  (HTTP ${createRes.status}):`, J(createJson));
    expect(createRes.status).toBe(200);
  });

  test("2. sends the template to the user with tenant context", async () => {
    const message = {
      to: { user_id: userId },
      context: { tenant_id: TENANT_ID },
      template: TEMPLATE_ID,
    };
    console.log(`\n===== SEND | to user_id + tenant =====`);
    console.log("SEND REQUEST  POST https://api.courier.com/send");
    console.log("body:", J({ message }));
    const sendRes = await fetch("https://api.courier.com/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ message }),
    });
    const sendJson = await sendRes.json();
    console.log(`SEND RESPONSE  (HTTP ${sendRes.status}):`, J(sendJson));
    requestId = sendJson.requestId;
    expect(sendRes.status).toBe(202);
    expect(requestId).toEqual(expect.any(String));
  });

  test("3. polls message status until it leaves the queue", async () => {
    console.log(`\n===== MESSAGE STATUS =====`);
    console.log(`STATUS REQUEST  GET https://api.courier.com/messages/${requestId}`);
    for (let attempt = 1; attempt <= 15; attempt++) {
      const statusRes = await fetch(`https://api.courier.com/messages/${requestId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      statusJson = await statusRes.json();
      console.log(`  attempt ${attempt}: HTTP ${statusRes.status} status=${statusJson.status}`);
      if (["SENT", "DELIVERED", "OPENED", "CLICKED"].includes(statusJson.status)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("STATUS RESPONSE (summary):", J({
      id: statusJson.id,
      status: statusJson.status,
      accountId: statusJson.accountId,
      enqueued: statusJson.enqueued,
      sent: statusJson.sent,
      channels: (statusJson.providers ?? []).map((p) => ({
        channel: p.channel?.name,
        provider: p.provider,
        statusCode: p.providerResponse?.providerResponse?.statusCode,
      })),
    }));
    expect(["SENT", "DELIVERED", "OPENED", "CLICKED"]).toContain(statusJson.status);
    // The message is tagged to the tenant at the message level.
    expect(statusJson.accountId).toBe(TENANT_ID);
  }, 60_000); // polling can take up to ~30s (15 attempts × 2s)

  test("4. a tenant-scoped JWT sees the user's tenant message (1)", async () => {
    const tenantScoped = await issueAndFetch(
      userId,
      "TENANT-SCOPED JWT (tenant_id in scope)",
      [`user_id:${userId}:${TENANT_ID}`, "inbox:read:messages", `tenant_id:${TENANT_ID}`, `account_id:${TENANT_ID}`].join(" ")
    );

    console.log(`\n===== RESULT =====`);
    console.log(`tenant-scoped JWT  -> message count = ${tenantScoped.totalCount}`);

    expect(tenantScoped.status).toBe(200);
    // KNOWN-FAILING (desired behavior): a tenant-scoped read should return the
    // user's tenant message. Today it returns 0 because the inbox-stored copy
    // persists accountId: null, so the account_id filter matches nothing. This
    // assertion is a regression check for when inbox ingest carries accountId through.
    expect(tenantScoped.totalCount).toBe(1);
  });

  test("5. a non-tenant JWT sees no tenant-scoped messages (0)", async () => {
    const nonTenant = await issueAndFetch(
      userId,
      "NON-TENANT JWT (no tenant_id in scope)",
      [`user_id:${userId}`, "inbox:read:messages"].join(" ")
    );

    console.log(`\n===== RESULT =====`);
    console.log(`non-tenant JWT     -> message count = ${nonTenant.totalCount}`);

    expect(nonTenant.status).toBe(200);
    // KNOWN-FAILING (desired behavior): a non-tenant read should NOT see the
    // tenant's message. Today it returns 1 because the inbox-stored copy has
    // accountId: null and the unscoped read applies no account filter. Regression
    // check for when inbox ingest carries accountId through.
    expect(nonTenant.totalCount).toBe(0);
  });
});
