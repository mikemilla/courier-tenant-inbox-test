// Piece 1 — the same tenant-inbox flow as tenant-inbox.test.js, but the READ is
// done through the real @trycourier/courier-js SDK instead of hand-rolled fetch.
//
// Flow:
//   1. create a user
//   2. SEND a message to { user_id } tagged with the tenant (context.tenant_id)   [REST]
//   3. issue a client JWT for that user                                           [REST]
//   4. READ the inbox twice through the SDK's CourierClient.inbox.getMessages():
//        a. WITH a tenant   -> new CourierClient({ ..., tenantId }) -> maps to params.accountId
//        b. WITHOUT a tenant -> new CourierClient({ ... })          -> no accountId filter
//
// courier-js is a browser-safe READ client (inbox/brands/prefs); it has no
// server send. So sending + JWT issuing still go through the REST API with the
// public key, exactly like the test. Run with: npm install && npm start
//
// Override env with COURIER_ENV=prod (defaults to dev, which has the
// accountId-ingest fix deployed).

// courier-js ships as CommonJS with no exports map, so its named exports aren't
// statically importable from ESM — pull them off the default export instead.
import courierJs from "@trycourier/courier-js";
const { CourierClient } = courierJs;

const ENVS = {
  dev: {
    API_URL: "https://1m5q00wehc.execute-api.us-east-1.amazonaws.com/dev",
    INBOX_GRAPHQL: "https://hfyaspnct6.execute-api.us-east-1.amazonaws.com/dev/q",
    API_KEY: "pk_RGDTG6A64A43WNGC2V61T4F8VCXY",
    TEMPLATE_ID: "nt_01ktcw0mjpfvjbfrtcrayq44jb",
  },
  prod: {
    API_URL: "https://api.courier.com",
    INBOX_GRAPHQL: "https://inbox.courier.com/q",
    API_KEY: "pk_CRRRYD4XM9MV6MM8VCG66FXJNDH0",
    TEMPLATE_ID: "nt_01ktc9s2gtf6bv471bjp2af1r4",
  },
};

const ENV = process.env.COURIER_ENV || "dev";
const cfg = ENVS[ENV];
if (!cfg) throw new Error(`unknown COURIER_ENV: ${ENV}`);

const TENANT_ID = process.env.COURIER_TENANT_ID || "sample-tenant";
const EMAIL = process.env.COURIER_EMAIL || "mike@courier.com";
const USER_ID = `sdk-${Math.floor(Math.random() * 1e9)}`;

const apiHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.API_KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The SDK reads from inbox.graphql; the other URLs are required by the type but
// unused by inbox.getMessages(). Point them all at the chosen environment.
const apiUrls = {
  courier: { rest: cfg.API_URL, graphql: `${cfg.API_URL}/client/q` },
  inbox: { graphql: cfg.INBOX_GRAPHQL, webSocket: "wss://realtime.courier.io" },
};

async function createUser() {
  const res = await fetch(`${cfg.API_URL}/profiles/${USER_ID}`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ profile: { email: EMAIL } }),
  });
  if (res.status !== 200) throw new Error(`createUser failed: HTTP ${res.status}`);
}

// Send the template to a single user, tagged with the tenant via context.tenant_id.
async function send() {
  const message = {
    to: { user_id: USER_ID },
    context: { tenant_id: TENANT_ID },
    template: cfg.TEMPLATE_ID,
  };
  const res = await fetch(`${cfg.API_URL}/send`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ message }),
  });
  const json = await res.json();
  if (!json.requestId) throw new Error(`send failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json.requestId;
}

async function pollStatus(requestId, attempts = 15) {
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(`${cfg.API_URL}/messages/${requestId}`, { headers: apiHeaders });
    const json = await res.json();
    if (["SENT", "DELIVERED", "OPENED", "CLICKED"].includes(json.status)) return json.status;
    await sleep(2000);
  }
  return "PENDING";
}

async function issueJwt() {
  const scope = [`user_id:${USER_ID}`, "inbox:read:messages", "inbox:write:events", "read:brands", "read:preferences"].join(" ");
  const res = await fetch(`${cfg.API_URL}/auth/issue-token`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ scope, expires_in: "1 day" }),
  });
  const { token } = await res.json();
  if (!token) throw new Error("issueJwt failed");
  return token;
}

// Read the inbox through the SDK. The ONLY difference between the two reads is
// whether tenantId is passed to the CourierClient constructor — the SDK maps it
// to params.accountId on every inbox request.
async function readWithSdk({ jwt, tenantId }) {
  const client = new CourierClient({ userId: USER_ID, jwt, tenantId, apiUrls });
  const res = await client.inbox.getMessages({ paginationLimit: 50 });
  const messages = res?.data?.messages;
  return { totalCount: messages?.totalCount ?? 0, nodes: messages?.nodes ?? [] };
}

async function main() {
  console.log(`[${ENV}] user=${USER_ID} tenant=${TENANT_ID}`);

  await createUser();
  const requestId = await send();
  console.log(`[${ENV}] sent to user_id WITH tenant context -> requestId=${requestId}`);
  const status = await pollStatus(requestId);
  console.log(`[${ENV}] message status=${status}`);
  await sleep(6000); // let the inbox copy persist

  const jwt = await issueJwt();

  const withTenant = await readWithSdk({ jwt, tenantId: TENANT_ID });
  const withoutTenant = await readWithSdk({ jwt });

  console.log("");
  console.log(`[${ENV}] SDK read WITH tenant    (tenantId="${TENANT_ID}") -> totalCount=${withTenant.totalCount}`);
  console.log(`[${ENV}] SDK read WITHOUT tenant  (no tenantId)            -> totalCount=${withoutTenant.totalCount}`);
  console.log("");
  console.log("Messages (with tenant):");
  for (const n of withTenant.nodes) {
    console.log(`  - ${n.messageId} accountId=${n.accountId} read=${n.read} title=${JSON.stringify(n.title)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
