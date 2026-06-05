// Courier tenant inbox delivery test — uses only `fetch` (no SDK).
//
// 1. Creates a user via the Courier API with an email address.
// 2. Sends the template to that user_id with tenant context.
// 3. Issues a JWT for the user, logs it, and decodes it.
// 4. Fetches the user's inbox from the inbox GraphQL API.
//
// Every call prints its request and response. Run with: node tenant-delivery-test.js

const API_KEY = "pk_CRRRYD4XM9MV6MM8VCG66FXJNDH0";
const TEMPLATE_ID = "nt_01ktc9s2gtf6bv471bjp2af1r4";
const TENANT_ID = "sample-tenant";
const EMAIL = "mike@courier.com";

const J = (o) => JSON.stringify(o, null, 2);

async function main() {
  const userId = `user-and-tenant-${Math.floor(Math.random() * 1e9)}`;

  // 1. Create the user (merge profile) with an email address.
  console.log(`===== CREATE USER | userId=${userId} =====`);
  console.log("CREATE REQUEST  POST https://api.courier.com/profiles/" + userId);
  const createBody = { profile: { email: EMAIL } };
  console.log("body:", J(createBody));
  const createRes = await fetch(`https://api.courier.com/profiles/${userId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(createBody),
  });
  console.log(`CREATE RESPONSE  (HTTP ${createRes.status}):`, J(await createRes.json()));

  // 2. Send the template to the user with tenant context.
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
  const requestId = sendJson.requestId;

  // Give Courier a few seconds to route the message to the inbox.
  await new Promise((r) => setTimeout(r, 10000));

  // 3. Issue a JWT for the user, log it, and decode it.
  const scope = [`user_id:${userId}`, "inbox:read:messages", "read:brands", "read:preferences"].join(" ");
  console.log(`\n===== ISSUE JWT =====`);
  console.log("ISSUE REQUEST  POST https://api.courier.com/auth/issue-token");
  const tokenBody = { scope, expires_in: "1 day" };
  console.log("body:", J(tokenBody));
  const tokenRes = await fetch("https://api.courier.com/auth/issue-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(tokenBody),
  });
  const { token: jwt } = await tokenRes.json();
  console.log(`ISSUE RESPONSE  (HTTP ${tokenRes.status})`);
  console.log("jwt:", jwt);
  const [, payload] = jwt.split(".");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  console.log("decoded payload:", J(decoded));

  // 4. Fetch the user's inbox from the inbox GraphQL API.
  const query = `query GetInboxMessages($params: FilterParamsInput = {}, $limit: Int = 50) {
  messages(params: $params, limit: $limit) {
    totalCount
    nodes { messageId accountId title preview created }
  }
}`;

  console.log(`\n===== GET MESSAGES (expecting ${requestId}) =====`);
  console.log("GET MESSAGES REQUEST  POST https://inbox.courier.com/q");
  console.log("headers:", J({ "x-courier-user-id": userId, Authorization: "Bearer <jwt>" }));
  console.log("body:", J({ query }));
  const inboxRes = await fetch("https://inbox.courier.com/q", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-courier-user-id": userId, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query }),
  });
  console.log(`GET MESSAGES RESPONSE  (HTTP ${inboxRes.status}):`, J(await inboxRes.json()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
