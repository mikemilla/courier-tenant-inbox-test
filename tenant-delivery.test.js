// Courier tenant inbox delivery test — uses only `fetch` (no SDK).
//
// Verifies tenant scoping of the inbox. The inbox is always read WITH a tenant +
// user_id (params.accountId = tenantId, the way courier-react reads in a tenanted
// app). What varies is how the message was SENT:
//
//   A. Sent WITH tenant + user_id  -> the tenant+user read SHOULD see it    (1)
//   B. Sent WITHOUT tenant (user_id only) -> the tenant+user read should NOT see it (0)
//
// Each scenario uses its own fresh user so the two don't cross-contaminate.
// Run with: npm test  (or: npx jest tenant-delivery.test.js)

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

// Create the user (merge profile) with an email address.
async function createUser(userId) {
  const res = await fetch(`https://api.courier.com/profiles/${userId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ profile: { email: EMAIL } }),
  });
  console.log(`CREATE USER ${userId} -> HTTP ${res.status}`);
  if (res.status !== 200) throw new Error(`create user failed: HTTP ${res.status}`);
}

// Send the template to the user. Includes context.tenant_id only when withTenant.
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

// Poll the Messages API until the message leaves the queue.
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

// Issue a user-scoped JWT (no tenant in the scope; the tenant is applied at read
// time via params.accountId, like courier-react).
async function issueUserJwt(userId) {
  const scope = [`user_id:${userId}`, "inbox:read:messages"].join(" ");
  const res = await fetch("https://api.courier.com/auth/issue-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ scope, expires_in: "1 day" }),
  });
  const { token } = await res.json();
  return token;
}

// Fetch the inbox WITH tenant + user_id: params.accountId = tenantId.
async function fetchInboxWithTenant(userId, jwt) {
  const variables = { params: { accountId: TENANT_ID }, limit: 50 };
  const res = await fetch("https://inbox.courier.com/q", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-courier-user-id": userId, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  console.log(`GET MESSAGES (tenant+user read) -> HTTP ${res.status}:`, J(json));
  return { status: res.status, totalCount: json?.data?.messages?.totalCount };
}

// Runs the full flow for one scenario and returns the tenant+user inbox count.
async function runScenario(withTenant) {
  const userId = `user-and-tenant-${Math.floor(Math.random() * 1e9)}`;
  console.log(`\n===== SCENARIO sent ${withTenant ? "WITH" : "WITHOUT"} tenant | userId=${userId} =====`);
  await createUser(userId);
  const requestId = await send(userId, withTenant);
  const status = await pollStatus(requestId);
  // Give OpenSearch a moment to index the inbox copy.
  await new Promise((r) => setTimeout(r, 6000));
  const jwt = await issueUserJwt(userId);
  const read = await fetchInboxWithTenant(userId, jwt);
  console.log(`RESULT: sent ${withTenant ? "WITH" : "WITHOUT"} tenant -> tenant+user read count = ${read.totalCount}`);
  return { userId, status, ...read };
}

describe("Courier tenant inbox scoping", () => {
  test("A. a message sent WITH tenant + user_id is visible to a tenant + user_id read", async () => {
    const r = await runScenario(true);
    expect(r.status).toBe(200);
    // DESIRED: a tenant+user read sees the tenant-scoped message.
    expect(r.totalCount).toBe(1);
  }, 90_000);

  test("B. a message sent WITHOUT tenant (user_id only) is NOT visible to a tenant + user_id read", async () => {
    const r = await runScenario(false);
    expect(r.status).toBe(200);
    // DESIRED: a tenant+user read does NOT see a message that was sent without a tenant.
    expect(r.totalCount).toBe(0);
  }, 90_000);
});
