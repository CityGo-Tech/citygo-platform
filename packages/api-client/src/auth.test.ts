import assert from "node:assert/strict";
import test from "node:test";
import { createClient, ApiError } from "./index.js";

const user = {
  id: "1",
  email: "admin@citygo.invalid",
  username: "admin",
  role: "super_admin" as const,
  mustChangePassword: true,
};

test("auth and password change retain additive account fields and exact password bytes", async () => {
  for (const native of [false, true]) {
    const requests: { path: string; body: unknown; native: string | null }[] =
      [];
    const result = {
      user,
      ...(native ? { token: "new-synthetic-session" } : {}),
    };
    const client = createClient("http://synthetic", {
      native,
      fetch: async (url, init) => {
        requests.push({
          path: String(url),
          body: JSON.parse(String(init?.body)),
          native: new Headers(init?.headers).get("X-CityGo-Client"),
        });
        return Response.json(result);
      },
    });
    assert.deepEqual(await client.auth("login", "admin", "admin"), result);
    assert.deepEqual(await client.changePassword("admin", "  а!b "), result);
    assert.deepEqual(requests, [
      {
        path: "http://synthetic/v1/auth/login",
        body: { email: "admin", password: "admin" },
        native: native ? "native" : null,
      },
      {
        path: "http://synthetic/v1/auth/password",
        body: { currentPassword: "admin", password: "  а!b " },
        native: native ? "native" : null,
      },
    ]);
  }
});

test("native password changes reject missing rotated token", async () => {
  const client = createClient("http://synthetic", {
    native: true,
    fetch: async () => Response.json({ user }),
  });
  await assert.rejects(
    client.changePassword("admin", "123456"),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_response",
  );
});

test("account list, role change and conversation start use bounded response contracts", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      const path = String(url);
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        path.endsWith("/accounts")
          ? { users: [user] }
          : path.endsWith("/role")
            ? { user }
            : { id: "7" },
      );
    },
  });
  assert.deepEqual(await client.accountUsers(), { users: [user] });
  assert.deepEqual(await client.setAccountRole("1", "super_admin"), { user });
  assert.deepEqual(await client.startConversation(), { id: "7" });
  assert.deepEqual(requests, [
    { path: "http://synthetic/v1/admin/accounts", method: "GET", body: null },
    {
      path: "http://synthetic/v1/admin/accounts/role",
      method: "POST",
      body: { userId: "1", role: "super_admin" },
    },
    {
      path: "http://synthetic/v1/conversations/start",
      method: "POST",
      body: {},
    },
  ]);
  const invalid = createClient("http://synthetic", {
    fetch: async () => Response.json({ users: Array(201).fill(user) }),
  });
  await assert.rejects(
    invalid.accountUsers(),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_response",
  );
});
