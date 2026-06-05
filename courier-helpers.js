// Shared Courier config + helpers for the sample suite (fetch-only, no SDK).
//
// Centralizes the environment the tests run against. Defaults to the shared DEV
// environment; override with COURIER_ENV=prod or any COURIER_* var below.
//
// The inbox read query, the read/unread/archive TrackEvent mutations, the
// FilterParamsInput fields, and the headers all mirror @trycourier/courier-js.

const ENVS = {
  dev: {
    API_URL: "https://1m5q00wehc.execute-api.us-east-1.amazonaws.com/dev",
    INBOX_URL: "https://hfyaspnct6.execute-api.us-east-1.amazonaws.com/dev/q",
    API_KEY: "pk_RGDTG6A64A43WNGC2V61T4F8VCXY",
    TEMPLATE_ID: "nt_01ktcw0mjpfvjbfrtcrayq44jb",
  },
  prod: {
    API_URL: "https://api.courier.com",
    INBOX_URL: "https://inbox.courier.com/q",
    API_KEY: "pk_CRRRYD4XM9MV6MM8VCG66FXJNDH0",
    TEMPLATE_ID: "nt_01ktc9s2gtf6bv471bjp2af1r4",
  },
};

const ENV = process.env.COURIER_ENV || "dev";
const base = ENVS[ENV] || ENVS.dev;

export const COURIER_ENV = ENV;
export const API_URL = process.env.COURIER_API_URL || base.API_URL;
export const INBOX_URL = process.env.COURIER_INBOX_URL || base.INBOX_URL;
export const API_KEY = process.env.COURIER_API_KEY || base.API_KEY;
export const TEMPLATE_ID = process.env.COURIER_TEMPLATE_ID || base.TEMPLATE_ID;
export const TENANT_ID = process.env.COURIER_TENANT_ID || "sample-tenant";
export const EMAIL = process.env.COURIER_EMAIL || "mike@courier.com";

export const J = (o) => JSON.stringify(o, null, 2);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randomUserId = (prefix = "user") => `${prefix}-${Math.floor(Math.random() * 1e9)}`;

const apiHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` };

// Create (merge) a user profile with an email address.
export async function createUser(userId, email = EMAIL) {
  const res = await fetch(`${API_URL}/profiles/${userId}`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ profile: { email } }),
  });
  if (res.status !== 200) throw new Error(`createUser failed: HTTP ${res.status}`);
  return res.status;
}

// Associate a user with a tenant (PUT /users/{id}/tenants/{tenant}) so tenant
// broadcasts (to: { tenant_id }) reach their inbox.
export async function addUserToTenant(userId, tenantId = TENANT_ID) {
  const res = await fetch(`${API_URL}/users/${userId}/tenants/${tenantId}`, {
    method: "PUT",
    headers: apiHeaders,
    body: JSON.stringify({ profile: {} }),
  });
  if (![200, 204].includes(res.status)) throw new Error(`addUserToTenant failed: HTTP ${res.status}`);
  return res.status;
}

// Send the template. By default sends to a single user (to: { user_id }); pass
// `toTenant` to broadcast to a whole tenant (to: { tenant_id }, no user_id).
// `tenantId` (when sending to a user) tags the message via context.tenant_id.
// Returns the requestId.
export async function send({ userId, tenantId, toTenant }) {
  const message = {
    to: toTenant ? { tenant_id: toTenant } : { user_id: userId },
    ...(tenantId ? { context: { tenant_id: tenantId } } : {}),
    template: TEMPLATE_ID,
  };
  const res = await fetch(`${API_URL}/send`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ message }),
  });
  const json = await res.json();
  if (!json.requestId) throw new Error(`send failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json.requestId;
}

// Poll the Messages API until the message leaves the queue. Returns the status JSON.
export async function pollStatus(requestId, attempts = 15) {
  let statusJson;
  for (let i = 1; i <= attempts; i++) {
    const res = await fetch(`${API_URL}/messages/${requestId}`, { headers: apiHeaders });
    statusJson = await res.json();
    if (["SENT", "DELIVERED", "OPENED", "CLICKED"].includes(statusJson.status)) break;
    await sleep(2000);
  }
  return statusJson;
}

const DEFAULT_SCOPES = [
  "inbox:read:messages",
  "inbox:write:events",
  "read:brands",
  "read:preferences",
];

// Issue a JWT scoped to the user. Returns { jwt, decoded }.
export async function userJwt(userId, scopes = DEFAULT_SCOPES) {
  const scope = [`user_id:${userId}`, ...scopes].join(" ");
  const res = await fetch(`${API_URL}/auth/issue-token`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ scope, expires_in: "1 day" }),
  });
  const { token: jwt } = await res.json();
  const decoded = jwt ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) : undefined;
  return { jwt, decoded };
}

// The inbox read query (mirrors courier-js's GetInboxMessages, single list).
const INBOX_QUERY = `query GetInboxMessages($params: FilterParamsInput, $limit: Int = 50, $after: String) {
  messages(params: $params, limit: $limit, after: $after) {
    totalCount
    pageInfo { startCursor hasNextPage }
    nodes { messageId accountId title preview created read archived }
  }
}`;

// Read the inbox. tenantId (if given) is mapped to params.accountId, like courier-react.
// Returns { httpStatus, totalCount, nodes, pageInfo }.
export async function readInbox({ jwt, userId, params = {}, tenantId, limit = 50, after }) {
  const mergedParams = { ...params, ...(tenantId ? { accountId: tenantId } : {}) };
  const res = await fetch(INBOX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-courier-user-id": userId, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query: INBOX_QUERY, variables: { params: mergedParams, limit, after } }),
  });
  const json = await res.json().catch(() => ({}));
  const messages = json?.data?.messages;
  return {
    httpStatus: res.status,
    totalCount: messages?.totalCount,
    nodes: messages?.nodes ?? [],
    pageInfo: messages?.pageInfo,
    raw: json,
  };
}

// Track an inbox event (read | unread | archive | opened | unpin), mirroring courier-js.
export async function inboxTrack({ jwt, userId, op, messageId }) {
  const mutation = `mutation TrackEvent($messageId: String!) { ${op}(messageId: $messageId) }`;
  const res = await fetch(INBOX_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-courier-user-id": userId, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query: mutation, variables: { messageId } }),
  });
  return { httpStatus: res.status, raw: await res.json().catch(() => ({})) };
}
