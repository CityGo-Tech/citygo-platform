import assert from "node:assert/strict";
import test from "node:test";
import {
  accountRoleSchema,
  accountUserSchema,
  changePasswordSchema,
  changeRoleSchema,
  credentialsSchema,
  loginSchema,
  registrationCredentialsSchema,
} from "./platform.js";
import {
  accountUserResponseSchema,
  adminUsersResponseSchema,
  authResponseSchema,
  nativeAuthResponseSchema,
} from "./responses.js";

const email = "synthetic@example.test";

test("registration accepts six arbitrary password characters without transformations", () => {
  assert.equal(credentialsSchema, registrationCredentialsSchema);
  assert.equal(
    credentialsSchema.safeParse({ email, password: "12345" }).success,
    false,
  );
  for (const password of [
    "123456",
    "пароль",
    "      ",
    " a! б ",
    "e\u0301 ab!",
    "x".repeat(128),
  ]) {
    assert.deepEqual(credentialsSchema.parse({ email, password }), {
      email,
      password,
    });
  }
  assert.equal(
    credentialsSchema.safeParse({ email, password: "x".repeat(129) }).success,
    false,
  );
  assert.equal(
    credentialsSchema.safeParse({ email: "admin", password: "123456" }).success,
    false,
  );
  assert.equal(
    credentialsSchema.safeParse({ email, password: "admin" }).success,
    false,
  );
});

test("login accepts email or username and preserves short existing passwords", () => {
  for (const identifier of ["admin", "Admin", " admin ", "USER@EXAMPLE.TEST"]) {
    assert.deepEqual(
      loginSchema.parse({ email: identifier, password: "admin" }),
      {
        email: identifier.trim().toLowerCase(),
        password: "admin",
      },
    );
  }
  assert.equal(
    loginSchema.parse({ email: "admin", password: " " }).password,
    " ",
  );
  for (const identifier of ["", " ", "bad user", "bad@", "x".repeat(65)])
    assert.equal(
      loginSchema.safeParse({ email: identifier, password: "admin" }).success,
      false,
    );
  assert.equal(
    loginSchema.safeParse({ email: "admin", password: "" }).success,
    false,
  );
  assert.equal(
    loginSchema.safeParse({ email: "admin", password: "x".repeat(129) })
      .success,
    false,
  );
});

test("password changes accept the bootstrap current password but require six new characters", () => {
  const input = { currentPassword: "admin", password: "  a!б " };
  assert.deepEqual(changePasswordSchema.parse(input), input);
  assert.equal(
    changePasswordSchema.safeParse({ ...input, password: "12345" }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({ ...input, currentPassword: "" }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({ ...input, password: "x".repeat(129) })
      .success,
    false,
  );
});

test("account roles and role commands reject invalid authority and IDs", () => {
  for (const role of ["user", "admin", "super_admin"] as const) {
    assert.equal(accountRoleSchema.parse(role), role);
    assert.deepEqual(changeRoleSchema.parse({ userId: "1", role }), {
      userId: "1",
      role,
    });
  }
  for (const userId of [
    "0",
    "01",
    "-1",
    "1.5",
    "1e2",
    " 1",
    "x",
    "1".repeat(20),
  ])
    assert.equal(
      changeRoleSchema.safeParse({ userId, role: "admin" }).success,
      false,
    );
  for (const role of ["owner", "superadmin", null, true])
    assert.equal(
      changeRoleSchema.safeParse({ userId: "1", role }).success,
      false,
    );
});

test("additive account response fields survive validation while legacy users remain valid", () => {
  const legacy = { id: "1", email };
  assert.deepEqual(accountUserSchema.parse(legacy), legacy);
  const user = {
    ...legacy,
    username: "admin",
    role: "super_admin" as const,
    mustChangePassword: true,
  };
  const auth = { user, token: "synthetic-token" };
  assert.deepEqual(authResponseSchema.parse(auth), auth);
  assert.deepEqual(nativeAuthResponseSchema.parse(auth), auth);
  assert.equal(nativeAuthResponseSchema.safeParse({ user }).success, false);
  assert.deepEqual(accountUserSchema.parse({ ...legacy, username: null }), {
    ...legacy,
    username: null,
  });
  for (const change of [
    { role: "owner" },
    { mustChangePassword: "yes" },
    { username: 4 },
  ])
    assert.equal(
      accountUserSchema.safeParse({ ...user, ...change }).success,
      false,
    );
  assert.deepEqual(accountUserResponseSchema.parse({ user, ignored: true }), {
    user,
  });
  assert.equal(
    adminUsersResponseSchema.safeParse({ users: Array(200).fill(user) })
      .success,
    true,
  );
  assert.equal(
    adminUsersResponseSchema.safeParse({ users: Array(201).fill(user) })
      .success,
    false,
  );
});
