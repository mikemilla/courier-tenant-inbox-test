// Courier tenant inbox suite — fetch-only, no SDK. All scenarios in one file.
//
// Central question (scenarios A/B): the inbox is always read WITH a tenant + user_id
// (params.accountId = tenantId, the way courier-react reads in a tenanted app). What
// varies is how the message was SENT:
//   A. Sent WITH tenant + user_id        -> the tenant+user read SHOULD see it (1)
//   B. Sent WITHOUT tenant (user_id only) -> the tenant+user read should NOT see it (0)
//
// Feature scenarios (read/unread, archive, pagination, auth) run on the no-tenant
// path so they're independent of tenant scoping.
//
// Config + helpers live in courier-helpers.js (defaults to shared dev).
// Run with: npm test  (or: COURIER_ENV=prod npm test)

import {
  TENANT_ID, randomUserId, createUser, addUserToTenant, send, pollStatus, userJwt, readInbox, inboxTrack, sleep,
} from "./courier-helpers.js";

// Create -> send (with/without tenant) -> wait for SENT -> read WITH tenant + user_id.
async function runScenario(withTenant) {
  const userId = randomUserId("scope");
  await createUser(userId);
  const requestId = await send({ userId, tenantId: withTenant ? TENANT_ID : undefined });
  await pollStatus(requestId);
  await sleep(6000); // let the inbox copy index
  const { jwt } = await userJwt(userId);
  const read = await readInbox({ jwt, userId, tenantId: TENANT_ID });
  console.log(`sent ${withTenant ? "WITH" : "WITHOUT"} tenant -> tenant+user read count = ${read.totalCount}`);
  return read;
}

describe("tenant inbox scoping", () => {
  test("A. a message sent WITH tenant + user_id is visible to a tenant + user_id read", async () => {
    const r = await runScenario(true);
    expect(r.httpStatus).toBe(200);
    expect(r.totalCount).toBe(1);
  }, 90_000);

  test("B. a message sent WITHOUT tenant (user_id only) is NOT visible to a tenant + user_id read", async () => {
    const r = await runScenario(false);
    expect(r.httpStatus).toBe(200);
    expect(r.totalCount).toBe(0);
  }, 90_000);
});

// Broadcast to a whole tenant (to: { tenant_id }, no user_id). The user must be a
// tenant member to receive it. Returns the receiving user's JWT for reading.
async function runBroadcastScenario() {
  const userId = randomUserId("bcast");
  await createUser(userId);
  await addUserToTenant(userId, TENANT_ID);
  const requestId = await send({ toTenant: TENANT_ID });
  await pollStatus(requestId);
  await sleep(8000); // broadcast fan-out + inbox indexing
  const { jwt } = await userJwt(userId);
  return { userId, jwt };
}

describe("tenant broadcast (sent to tenant, no user_id)", () => {
  test("C. a tenant broadcast IS visible to a tenant + user_id read", async () => {
    const { userId, jwt } = await runBroadcastScenario();
    const read = await readInbox({ jwt, userId, tenantId: TENANT_ID });
    console.log(`broadcast -> tenant+user read count = ${read.totalCount}`);
    expect(read.httpStatus).toBe(200);
    expect(read.totalCount).toBe(1);
  }, 120_000);

  test("D. a tenant broadcast is NOT visible to a user_id read with no tenant", async () => {
    const { userId, jwt } = await runBroadcastScenario();
    const read = await readInbox({ jwt, userId, params: {} }); // no accountId filter
    console.log(`broadcast -> user-only read count = ${read.totalCount}`);
    expect(read.httpStatus).toBe(200);
    expect(read.totalCount).toBe(0);
  }, 120_000);
});

describe("inbox feature surface", () => {
  test("read / unread: marking a message toggles its read state and the status filter", async () => {
    const userId = randomUserId("rw");
    await createUser(userId);
    await pollStatus(await send({ userId }));
    await sleep(6000);
    const { jwt } = await userJwt(userId);

    const initial = await readInbox({ jwt, userId, params: {} });
    expect(initial.totalCount).toBeGreaterThanOrEqual(1);
    const messageId = initial.nodes[0].messageId;
    expect(initial.nodes[0].read).toBeFalsy();

    await inboxTrack({ jwt, userId, op: "read", messageId });
    await sleep(2000);
    const afterRead = await readInbox({ jwt, userId, params: { status: "read" } });
    expect(afterRead.nodes.some((n) => n.messageId === messageId && n.read)).toBe(true);

    await inboxTrack({ jwt, userId, op: "unread", messageId });
    await sleep(2000);
    const afterUnread = await readInbox({ jwt, userId, params: { status: "unread" } });
    expect(afterUnread.nodes.some((n) => n.messageId === messageId)).toBe(true);
  }, 90_000);

  test("archive: an archived message leaves the default list and appears under archived:true", async () => {
    const userId = randomUserId("arch");
    await createUser(userId);
    await pollStatus(await send({ userId }));
    await sleep(6000);
    const { jwt } = await userJwt(userId);

    const before = await readInbox({ jwt, userId, params: {} });
    const messageId = before.nodes[0].messageId;

    await inboxTrack({ jwt, userId, op: "archive", messageId });
    await sleep(2000);

    const defaultList = await readInbox({ jwt, userId, params: {} });
    expect(defaultList.nodes.some((n) => n.messageId === messageId)).toBe(false);

    const archivedList = await readInbox({ jwt, userId, params: { archived: true } });
    expect(archivedList.nodes.some((n) => n.messageId === messageId)).toBe(true);
  }, 90_000);

  test("pagination: limit + after cursor walks the message list", async () => {
    const userId = randomUserId("page");
    await createUser(userId);
    await pollStatus(await send({ userId }));
    await pollStatus(await send({ userId }));
    await pollStatus(await send({ userId }));
    await sleep(8000);
    const { jwt } = await userJwt(userId);

    const page1 = await readInbox({ jwt, userId, params: {}, limit: 1 });
    expect(page1.totalCount).toBeGreaterThanOrEqual(2);
    expect(page1.nodes).toHaveLength(1);
    expect(page1.pageInfo.hasNextPage).toBe(true);
    expect(page1.pageInfo.startCursor).toBeTruthy();

    const page2 = await readInbox({ jwt, userId, params: {}, limit: 1, after: page1.pageInfo.startCursor });
    expect(page2.nodes).toHaveLength(1);
    expect(page2.nodes[0].messageId).not.toBe(page1.nodes[0].messageId);
  }, 120_000);

  test("auth: an invalid JWT is rejected (no data returned)", async () => {
    const userId = randomUserId("badjwt");
    const read = await readInbox({ jwt: "not-a-real-jwt", userId, params: {} });
    console.log(`invalid-JWT read -> HTTP ${read.httpStatus}`);
    expect(read.totalCount === undefined || read.totalCount === 0).toBe(true);
  }, 30_000);
});
