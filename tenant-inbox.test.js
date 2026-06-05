// Courier tenant inbox suite — fetch-only, no SDK. Everything in one file.
//
// Runs the SAME scenarios against BOTH dev and prod (override with
// COURIER_ENVS=dev or COURIER_ENVS=prod). Expectations are identical in every
// env — they encode the DESIRED behavior — so:
//   - dev has the accountId-ingest fix deployed  -> A/C pass
//   - prod does not                              -> A/C fail (expected)
//   - D depends on the inbox provider's tenantFiltering, which is off in BOTH
//     envs, so D fails the same way in both (read returns 1, desired 0).
//
// Scenarios (the inbox is always read WITH a tenant unless noted):
//   A. Sent to user_id WITH tenant            -> tenant+user read sees it   (1)
//   B. Sent to user_id WITHOUT tenant         -> tenant+user read does not  (0)
//   C. Broadcast to tenant (no user_id)       -> tenant+user read sees it   (1)
//   D. Broadcast to tenant (no user_id)       -> user-only read (no tenant) (0)
//   + feature surface: read/unread, archive, pagination, invalid-JWT.
//
// Run with: npm test

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

const TENANT_ID = process.env.COURIER_TENANT_ID || "sample-tenant";
const EMAIL = process.env.COURIER_EMAIL || "mike@courier.com";
const ENV_NAMES = (process.env.COURIER_ENVS || "dev,prod").split(",").map((s) => s.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomUserId = (prefix = "user") => `${prefix}-${Math.floor(Math.random() * 1e9)}`;

// Build a client bound to one environment's config.
function makeClient(cfg) {
  const apiHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.API_KEY}` };

  async function createUser(userId, email = EMAIL) {
    const res = await fetch(`${cfg.API_URL}/profiles/${userId}`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ profile: { email } }),
    });
    if (res.status !== 200) throw new Error(`createUser failed: HTTP ${res.status}`);
    return res.status;
  }

  // Associate a user with a tenant so tenant broadcasts reach their inbox.
  async function addUserToTenant(userId, tenantId = TENANT_ID) {
    const res = await fetch(`${cfg.API_URL}/users/${userId}/tenants/${tenantId}`, {
      method: "PUT",
      headers: apiHeaders,
      body: JSON.stringify({ profile: {} }),
    });
    if (![200, 204].includes(res.status)) throw new Error(`addUserToTenant failed: HTTP ${res.status}`);
    return res.status;
  }

  // Send the template. Default: to a single user (to: { user_id }). Pass `toTenant`
  // to broadcast to a whole tenant (to: { tenant_id }, no user_id). `tenantId`
  // tags a single-user send via context.tenant_id. Returns the requestId.
  async function send({ userId, tenantId, toTenant }) {
    const message = {
      to: toTenant ? { tenant_id: toTenant } : { user_id: userId },
      ...(tenantId ? { context: { tenant_id: tenantId } } : {}),
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
    let statusJson;
    for (let i = 1; i <= attempts; i++) {
      const res = await fetch(`${cfg.API_URL}/messages/${requestId}`, { headers: apiHeaders });
      statusJson = await res.json();
      if (["SENT", "DELIVERED", "OPENED", "CLICKED"].includes(statusJson.status)) break;
      await sleep(2000);
    }
    return statusJson;
  }

  const DEFAULT_SCOPES = ["inbox:read:messages", "inbox:write:events", "read:brands", "read:preferences"];

  async function userJwt(userId, scopes = DEFAULT_SCOPES) {
    const scope = [`user_id:${userId}`, ...scopes].join(" ");
    const res = await fetch(`${cfg.API_URL}/auth/issue-token`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ scope, expires_in: "1 day" }),
    });
    const { token: jwt } = await res.json();
    const decoded = jwt ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) : undefined;
    return { jwt, decoded };
  }

  const INBOX_QUERY = `query GetInboxMessages($params: FilterParamsInput, $limit: Int = 50, $after: String) {
    messages(params: $params, limit: $limit, after: $after) {
      totalCount
      pageInfo { startCursor hasNextPage }
      nodes { messageId accountId title preview created read archived }
    }
  }`;

  // Read the inbox. tenantId (if given) maps to params.accountId, like courier-react.
  async function readInbox({ jwt, userId, params = {}, tenantId, limit = 50, after }) {
    const mergedParams = { ...params, ...(tenantId ? { accountId: tenantId } : {}) };
    const res = await fetch(cfg.INBOX_URL, {
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

  // Track an inbox event (read | unread | archive | opened), mirroring courier-js.
  async function inboxTrack({ jwt, userId, op, messageId }) {
    const mutation = `mutation TrackEvent($messageId: String!) { ${op}(messageId: $messageId) }`;
    const res = await fetch(cfg.INBOX_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-courier-user-id": userId, Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ query: mutation, variables: { messageId } }),
    });
    return { httpStatus: res.status, raw: await res.json().catch(() => ({})) };
  }

  return { createUser, addUserToTenant, send, pollStatus, userJwt, readInbox, inboxTrack };
}

// Same suite, run against each environment with identical expectations.
for (const envName of ENV_NAMES) {
  const cfg = ENVS[envName];
  if (!cfg) throw new Error(`unknown COURIER_ENV: ${envName}`);
  const c = makeClient(cfg);

  // create -> send (with/without tenant) -> wait for SENT -> read WITH tenant + user_id.
  async function runScenario(withTenant) {
    const userId = randomUserId("scope");
    await c.createUser(userId);
    const requestId = await c.send({ userId, tenantId: withTenant ? TENANT_ID : undefined });
    await c.pollStatus(requestId);
    await sleep(6000);
    const { jwt } = await c.userJwt(userId);
    const read = await c.readInbox({ jwt, userId, tenantId: TENANT_ID });
    console.log(`[${envName}] sent ${withTenant ? "WITH" : "WITHOUT"} tenant -> tenant+user read = ${read.totalCount}`);
    return read;
  }

  // Broadcast to the tenant (no user_id); the user is a tenant member.
  async function runBroadcast() {
    const userId = randomUserId("bcast");
    await c.createUser(userId);
    await c.addUserToTenant(userId, TENANT_ID);
    const requestId = await c.send({ toTenant: TENANT_ID });
    await c.pollStatus(requestId);
    await sleep(8000);
    const { jwt } = await c.userJwt(userId);
    return { userId, jwt };
  }

  describe(`[${envName}] tenant inbox scoping`, () => {
    test("A. sent to user_id WITH tenant is visible to a tenant + user_id read", async () => {
      const r = await runScenario(true);
      expect(r.httpStatus).toBe(200);
      expect(r.totalCount).toBe(1);
    }, 90_000);

    test("B. sent to user_id WITHOUT tenant is NOT visible to a tenant + user_id read", async () => {
      const r = await runScenario(false);
      expect(r.httpStatus).toBe(200);
      expect(r.totalCount).toBe(0);
    }, 90_000);
  });

  describe(`[${envName}] tenant broadcast (sent to tenant, no user_id)`, () => {
    test("C. a tenant broadcast IS visible to a tenant + user_id read", async () => {
      const { userId, jwt } = await runBroadcast();
      const read = await c.readInbox({ jwt, userId, tenantId: TENANT_ID });
      console.log(`[${envName}] broadcast -> tenant+user read = ${read.totalCount}`);
      expect(read.httpStatus).toBe(200);
      expect(read.totalCount).toBe(1);
    }, 120_000);

    test("D. a tenant broadcast is NOT visible to a user_id read with no tenant", async () => {
      const { userId, jwt } = await runBroadcast();
      const read = await c.readInbox({ jwt, userId, params: {} }); // no accountId filter
      console.log(`[${envName}] broadcast -> user-only read = ${read.totalCount}`);
      expect(read.httpStatus).toBe(200);
      expect(read.totalCount).toBe(0);
    }, 120_000);

    test("E. broadcast to a NON-EXISTENT tenant (never created, no member) delivers nothing", async () => {
      const ghostTenant = randomUserId("ghost-tenant"); // random id that was never created
      const userId = randomUserId("ghost");
      await c.createUser(userId); // user exists, but is NOT a member of ghostTenant

      let sendOutcome = "accepted";
      let requestId;
      try {
        requestId = await c.send({ toTenant: ghostTenant });
      } catch (e) {
        sendOutcome = e.message; // send rejected (e.g. tenant doesn't exist)
      }
      if (requestId) await c.pollStatus(requestId);
      await sleep(8000);

      const { jwt } = await c.userJwt(userId);
      const tenantRead = await c.readInbox({ jwt, userId, tenantId: ghostTenant }); // with tenant + user
      const userOnlyRead = await c.readInbox({ jwt, userId, params: {} }); // user only, no tenant
      console.log(`[${envName}] non-existent tenant: send=${sendOutcome} tenant+user read=${tenantRead.totalCount} user-only read=${userOnlyRead.totalCount}`);

      // OBSERVED: with no member of a non-existent tenant, neither read surfaces a message.
      expect(tenantRead.totalCount).toBe(0);
      expect(userOnlyRead.totalCount).toBe(0);
    }, 120_000);
  });

  describe(`[${envName}] inbox feature surface`, () => {
    test("read / unread: marking a message toggles its read state and the status filter", async () => {
      const userId = randomUserId("rw");
      await c.createUser(userId);
      await c.pollStatus(await c.send({ userId }));
      await sleep(6000);
      const { jwt } = await c.userJwt(userId);

      const initial = await c.readInbox({ jwt, userId, params: {} });
      expect(initial.totalCount).toBeGreaterThanOrEqual(1);
      const messageId = initial.nodes[0].messageId;
      expect(initial.nodes[0].read).toBeFalsy();

      await c.inboxTrack({ jwt, userId, op: "read", messageId });
      await sleep(2000);
      const afterRead = await c.readInbox({ jwt, userId, params: { status: "read" } });
      expect(afterRead.nodes.some((n) => n.messageId === messageId && n.read)).toBe(true);

      await c.inboxTrack({ jwt, userId, op: "unread", messageId });
      await sleep(2000);
      const afterUnread = await c.readInbox({ jwt, userId, params: { status: "unread" } });
      expect(afterUnread.nodes.some((n) => n.messageId === messageId)).toBe(true);
    }, 90_000);

    test("archive: an archived message leaves the default list and appears under archived:true", async () => {
      const userId = randomUserId("arch");
      await c.createUser(userId);
      await c.pollStatus(await c.send({ userId }));
      await sleep(6000);
      const { jwt } = await c.userJwt(userId);

      const before = await c.readInbox({ jwt, userId, params: {} });
      const messageId = before.nodes[0].messageId;

      await c.inboxTrack({ jwt, userId, op: "archive", messageId });
      await sleep(2000);

      const defaultList = await c.readInbox({ jwt, userId, params: {} });
      expect(defaultList.nodes.some((n) => n.messageId === messageId)).toBe(false);

      const archivedList = await c.readInbox({ jwt, userId, params: { archived: true } });
      expect(archivedList.nodes.some((n) => n.messageId === messageId)).toBe(true);
    }, 90_000);

    test("pagination: limit + after cursor walks the message list", async () => {
      const userId = randomUserId("page");
      await c.createUser(userId);
      await c.pollStatus(await c.send({ userId }));
      await c.pollStatus(await c.send({ userId }));
      await c.pollStatus(await c.send({ userId }));
      await sleep(8000);
      const { jwt } = await c.userJwt(userId);

      const page1 = await c.readInbox({ jwt, userId, params: {}, limit: 1 });
      expect(page1.totalCount).toBeGreaterThanOrEqual(2);
      expect(page1.nodes).toHaveLength(1);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      expect(page1.pageInfo.startCursor).toBeTruthy();

      const page2 = await c.readInbox({ jwt, userId, params: {}, limit: 1, after: page1.pageInfo.startCursor });
      expect(page2.nodes).toHaveLength(1);
      expect(page2.nodes[0].messageId).not.toBe(page1.nodes[0].messageId);
    }, 120_000);

    test("auth: an invalid JWT is rejected (no data returned)", async () => {
      const userId = randomUserId("badjwt");
      const read = await c.readInbox({ jwt: "not-a-real-jwt", userId, params: {} });
      console.log(`[${envName}] invalid-JWT read -> HTTP ${read.httpStatus}`);
      expect(read.totalCount === undefined || read.totalCount === 0).toBe(true);
    }, 30_000);
  });
}
