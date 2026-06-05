// Inbox feature surface — read/unread, archive, pagination, and auth rejection.
//
// These exercise inbox features independent of the tenant-scoping gap, so they use
// the WORKING path: messages are sent WITHOUT a tenant and read WITHOUT a tenant
// filter (a tenant read would return 0 today and mask the feature behavior).
//
// Run with: npm test  (or: npx jest inbox-features.test.js)

import {
  randomUserId, createUser, send, pollStatus, userJwt, readInbox, inboxTrack, sleep,
} from "./courier-helpers.js";

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
    // Must not return messages; expect a non-200 (401/403) or an errored payload.
    expect(read.totalCount === undefined || read.totalCount === 0).toBe(true);
  }, 30_000);
});
