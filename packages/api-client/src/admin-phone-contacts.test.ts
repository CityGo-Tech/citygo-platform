import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createClient } from "./index.js";

const contact = {
  userId: "9",
  email: "synthetic@example.test",
  username: null,
  phone: "+79000000001",
  verifiedAt: "2026-10-28T00:00:00.000Z",
};
const invalidResponse = (error: unknown) =>
  error instanceof ApiError && error.code === "invalid_response";

test("customer phone pages use read-only bounded cursors without sending numbers", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return Response.json({ contacts: [contact], nextAfterUserId: null });
    },
  });
  const expected = { contacts: [contact], nextAfterUserId: null };
  assert.deepEqual(await client.adminPhoneContacts(), expected);
  assert.deepEqual(
    await client.adminPhoneContacts({ afterUserId: "8" }),
    expected,
  );
  assert.deepEqual(calls, [
    {
      url: "http://synthetic/v1/admin/phone-contacts",
      method: "GET",
      body: undefined,
    },
    {
      url: "http://synthetic/v1/admin/phone-contacts?afterUserId=8",
      method: "GET",
      body: undefined,
    },
  ]);
  for (const afterUserId of [
    "0",
    "-1",
    "01",
    "1&export=true",
    "9".repeat(19),
  ]) {
    await assert.rejects(client.adminPhoneContacts({ afterUserId }));
  }
  assert.equal(calls.length, 2);
});

test("customer phone pages reject wrong, duplicate and stale page contents", async () => {
  const pages = [
    { contacts: [{ ...contact, phone: "79000000001" }], nextAfterUserId: null },
    {
      contacts: [{ ...contact, protectedPhone: "must-not-escape" }],
      nextAfterUserId: null,
    },
    { contacts: [contact, contact], nextAfterUserId: null },
    {
      contacts: [{ ...contact, userId: "10" }, contact],
      nextAfterUserId: null,
    },
    { contacts: [contact], nextAfterUserId: "9" },
    {
      contacts: Array.from({ length: 51 }, (_, i) => ({
        ...contact,
        userId: String(i + 1),
      })),
      nextAfterUserId: null,
    },
  ];
  for (const page of pages) {
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(page),
    });
    await assert.rejects(client.adminPhoneContacts(), invalidResponse);
  }
  const stale = createClient("http://synthetic", {
    fetch: async () =>
      Response.json({ contacts: [contact], nextAfterUserId: null }),
  });
  await assert.rejects(
    stale.adminPhoneContacts({ afterUserId: "9" }),
    invalidResponse,
  );
});
