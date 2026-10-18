import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  AccountAccess,
  DomainError,
  Repository,
  connectDatabase,
  migrate,
  type AccountRole,
} from "./index.js";

async function fixture(t: TestContext) {
  // Always synthetic in-memory PGlite; never consume an inherited database URL.
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const access = new AccountAccess(db);
  const repo = new Repository(db);
  const addUser = (email: string) => repo.register(email, "synthetic-old-hash");
  const bootstrap = async () => {
    const admin = await access.bootstrapAdmin("synthetic-bootstrap-hash");
    await access.changePassword(
      admin.id,
      "synthetic-bootstrap-hash",
      "synthetic-admin-hash",
      "a".repeat(64),
    );
    return admin.id;
  };
  return { db, access, repo, addUser, bootstrap };
}
function status(code: number) {
  return (error: unknown) =>
    error instanceof DomainError && error.statusCode === code;
}

test("account migration defaults, username constraints and active-only credential lookup", async (t) => {
  const { db, access, addUser } = await fixture(t);
  const id = await addUser("first@example.test");
  assert.deepEqual(await access.info(id), {
    id,
    email: "first@example.test",
    username: null,
    role: "user",
    mustChangePassword: false,
  });
  await db.query("update users set username='first' where id=$1", [id]);
  assert.equal((await access.credentials(" FIRST "))?.id, id);
  assert.equal((await access.credentials("FIRST@EXAMPLE.TEST"))?.id, id);
  assert.equal(
    (await access.credentials("first"))?.password_hash,
    "synthetic-old-hash",
  );
  assert.equal(await access.credentials("missing"), undefined);
  assert.equal(await access.credentials(" "), undefined);
  assert.equal(await access.credentials("x".repeat(255)), undefined);
  const other = await addUser("second@example.test");
  for (const username of ["first", "First", " leading", "", "has@sign"])
    await assert.rejects(
      db.query("update users set username=$2 where id=$1", [other, username]),
    );
  await assert.rejects(
    db.query("update users set role='owner' where id=$1", [id]),
  );
  await db.query("update users set status='blocked' where id=$1", [id]);
  assert.equal(await access.info(id), undefined);
  assert.equal(await access.credentials("first"), undefined);
  assert.equal(await access.credentials("first@example.test"), undefined);
  assert.equal(await access.info("999999"), undefined);
});

test("bootstrap is empty-only, explicitly temporary and cannot be repeated after deletion", async (t) => {
  const { db, access } = await fixture(t);
  const admin = await access.bootstrapAdmin("synthetic-bootstrap-hash");
  assert.deepEqual(admin, {
    id: "1",
    email: "admin@citygo.invalid",
    username: "admin",
    role: "super_admin",
    mustChangePassword: true,
  });
  assert.equal((await access.credentials("ADMIN"))?.id, admin.id);
  await assert.rejects(access.list(admin.id), status(403));
  await assert.rejects(access.bootstrapAdmin("replacement-hash"), status(409));
  assert.equal(
    (await access.credentials("admin"))?.password_hash,
    "synthetic-bootstrap-hash",
  );
  await db.query("delete from users where id=$1", [admin.id]);
  await assert.rejects(access.bootstrapAdmin("replacement-hash"), status(409));
  assert.equal((await db.query("select id from users")).rows.length, 0);
  assert.equal(
    (
      await db.query<{ bootstrap_completed: boolean }>(
        "select bootstrap_completed from account_security_state where id=1",
      )
    ).rows[0]!.bootstrap_completed,
    true,
  );
});

test("bootstrap rejects an occupied database without changing users or its one-time flag", async (t) => {
  const { db, access, addUser } = await fixture(t);
  await addUser("existing@example.test");
  await assert.rejects(
    access.bootstrapAdmin("synthetic-bootstrap-hash"),
    status(409),
  );
  assert.equal((await db.query("select id from users")).rows.length, 1);
  assert.equal((await db.query("select id from audit_log")).rows.length, 0);
  assert.equal(
    (
      await db.query<{ bootstrap_completed: boolean }>(
        "select bootstrap_completed from account_security_state where id=1",
      )
    ).rows[0]!.bootstrap_completed,
    false,
  );
});

test("only a current active non-temporary super-admin can list or assign roles", async (t) => {
  const { db, access, addUser, bootstrap, repo } = await fixture(t);
  const owner = await bootstrap();
  const user = await addUser("user@example.test");
  await assert.rejects(access.list(user), status(403));
  await assert.rejects(access.setRole(user, user, "super_admin"), status(403));
  await repo.createSession(user, "old-target-session");
  const promoted = await access.setRole(owner, user, "admin");
  assert.equal(promoted.role, "admin");
  assert.equal(
    (await db.query("select 1 from sessions where user_id=$1", [user])).rows
      .length,
    0,
  );
  await assert.rejects(access.list(user), status(403));
  await assert.rejects(access.setRole(user, owner, "user"), status(403));
  assert.equal(
    (await access.setRole(owner, user, "super_admin")).role,
    "super_admin",
  );
  assert.equal((await access.list(user)).length, 2);
  const beforeAudit = (await db.query("select id from audit_log")).rows.length;
  await access.setRole(owner, user, "super_admin");
  assert.equal(
    (await db.query("select id from audit_log")).rows.length,
    beforeAudit,
  );
  await db.query("update users set must_change_password=true where id=$1", [
    user,
  ]);
  await assert.rejects(access.list(user), status(403));
  await assert.rejects(access.setRole(user, owner, "admin"), status(403));
  await db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [user],
  );
  await assert.rejects(access.list(user), status(403));
  await assert.rejects(access.setRole(user, owner, "admin"), status(403));
  await assert.rejects(access.setRole(owner, user, "admin"), status(404));
  await assert.rejects(access.setRole(owner, "999999", "admin"), status(404));
  await assert.rejects(
    access.setRole(owner, owner, "owner" as AccountRole),
    status(400),
  );
});

test("role changes protect the last super-admin, self-demotion and serialized competing changes", async (t) => {
  const { access, addUser, bootstrap } = await fixture(t);
  const owner = await bootstrap();
  await assert.rejects(access.setRole(owner, owner, "user"), status(409));
  const peer = await addUser("peer@example.test");
  await access.setRole(owner, peer, "super_admin");
  await assert.rejects(access.setRole(owner, owner, "admin"), status(409));
  const changes = await Promise.allSettled([
    access.setRole(owner, peer, "admin"),
    access.setRole(peer, owner, "admin"),
  ]);
  // PGlite queues transactions; this verifies the same serialized state-machine
  // invariant, not independent PostgreSQL connections or real row-lock races.
  assert.equal(
    changes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    changes.filter((result) => result.status === "rejected").length,
    1,
  );
  const accounts = [await access.info(owner), await access.info(peer)];
  assert.equal(
    accounts.filter((user) => user?.role === "super_admin").length,
    1,
  );
});

test("password rotation uses CAS, revokes every old session and stores no secrets in audit", async (t) => {
  const { db, access, repo } = await fixture(t);
  const admin = await access.bootstrapAdmin("synthetic-bootstrap-hash");
  await repo.createSession(admin.id, "old-one");
  await repo.createSession(admin.id, "old-two");
  await assert.rejects(
    access.changePassword(admin.id, "wrong-hash", "new-hash", "b".repeat(64)),
    status(409),
  );
  assert.equal((await db.query("select 1 from sessions")).rows.length, 2);
  assert.equal((await access.info(admin.id))?.mustChangePassword, true);
  const result = await access.changePassword(
    admin.id,
    "synthetic-bootstrap-hash",
    "synthetic-new-password-hash",
    "b".repeat(64),
  );
  assert.equal(result.mustChangePassword, false);
  assert.equal(
    (await access.credentials("admin"))?.password_hash,
    "synthetic-new-password-hash",
  );
  const sessions = await db.query<{
    token_hash: string;
    correct_expiry: boolean;
  }>(
    "select token_hash,expires_at>now()+interval '6 days 23 hours' and expires_at<=now()+interval '7 days' as correct_expiry from sessions",
  );
  assert.deepEqual(sessions.rows, [
    { token_hash: "b".repeat(64), correct_expiry: true },
  ]);
  assert.equal(await repo.session("old-one"), undefined);
  assert.equal(await repo.session("old-two"), undefined);
  assert.equal((await access.list(admin.id)).length, 1);
  const audit = JSON.stringify(
    (await db.query("select action,payload from audit_log")).rows,
  );
  assert.match(audit, /account-password-changed/);
  for (const secret of [
    "synthetic-bootstrap-hash",
    "synthetic-new-password-hash",
    "b".repeat(64),
  ])
    assert.equal(audit.includes(secret), false);
});

test("failed session creation rolls password rotation and session revocation back atomically", async (t) => {
  const { db, access, repo, addUser } = await fixture(t);
  const admin = await access.bootstrapAdmin("synthetic-bootstrap-hash");
  const other = await addUser("other@example.test");
  await repo.createSession(admin.id, "old-session");
  await repo.createSession(other, "c".repeat(64));
  await assert.rejects(
    access.changePassword(
      admin.id,
      "synthetic-bootstrap-hash",
      "new-hash",
      "c".repeat(64),
    ),
  );
  assert.equal(
    (await access.credentials("admin"))?.password_hash,
    "synthetic-bootstrap-hash",
  );
  assert.equal((await access.info(admin.id))?.mustChangePassword, true);
  assert.equal((await db.query("select 1 from sessions")).rows.length, 2);
  assert.equal(
    (
      await db.query(
        "select 1 from audit_log where action='account-password-changed'",
      )
    ).rows.length,
    0,
  );
  await db.query("update users set status='blocked' where id=$1", [admin.id]);
  await assert.rejects(
    access.changePassword(
      admin.id,
      "synthetic-bootstrap-hash",
      "new-hash",
      "d".repeat(64),
    ),
    status(401),
  );
});

test("two password updates using the same old hash cannot both succeed", async (t) => {
  const { access, addUser, db } = await fixture(t);
  const user = await addUser("cas@example.test");
  const changes = await Promise.allSettled([
    access.changePassword(
      user,
      "synthetic-old-hash",
      "winner-one",
      "1".repeat(64),
    ),
    access.changePassword(
      user,
      "synthetic-old-hash",
      "winner-two",
      "2".repeat(64),
    ),
  ]);
  assert.equal(
    changes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    changes.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(
    (await db.query("select 1 from sessions where user_id=$1", [user])).rows
      .length,
    1,
  );
  assert.equal(
    (
      await db.query(
        "select 1 from audit_log where action='account-password-changed'",
      )
    ).rows.length,
    1,
  );
});

test("verified session admission cannot revive a password invalidated during verification", async (t) => {
  const { access, db } = await fixture(t);
  const admin = await access.bootstrapAdmin("synthetic-bootstrap-hash");
  // A temporary bootstrap account must be able to sign in to change its password.
  const initial = await access.createVerifiedSession(
    admin.id,
    "synthetic-bootstrap-hash",
    "4".repeat(64),
  );
  assert.equal(initial.mustChangePassword, true);
  assert.equal("password_hash" in initial, false);
  await access.changePassword(
    admin.id,
    "synthetic-bootstrap-hash",
    "synthetic-new-hash",
    "5".repeat(64),
  );
  // Simulates a login which checked the old password before the rotation commit.
  await assert.rejects(
    access.createVerifiedSession(
      admin.id,
      "synthetic-bootstrap-hash",
      "6".repeat(64),
    ),
    status(401),
  );
  assert.equal(
    (
      await db.query("select 1 from sessions where token_hash=$1", [
        "4".repeat(64),
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query("select 1 from sessions where token_hash=$1", [
        "6".repeat(64),
      ])
    ).rows.length,
    0,
  );
  const current = await access.createVerifiedSession(
    admin.id,
    "synthetic-new-hash",
    "7".repeat(64),
  );
  assert.equal(current.mustChangePassword, false);
  await db.query("update users set status='blocked' where id=$1", [admin.id]);
  await assert.rejects(
    access.createVerifiedSession(
      admin.id,
      "synthetic-new-hash",
      "8".repeat(64),
    ),
    status(401),
  );
  await assert.rejects(
    access.createVerifiedSession(
      "999999",
      "synthetic-new-hash",
      "9".repeat(64),
    ),
    status(401),
  );
});

test("account lists are bounded and public data never contains credential hashes", async (t) => {
  const { db, access, bootstrap } = await fixture(t);
  const owner = await bootstrap();
  await db.query(
    "insert into users(auth_subject) select 'synthetic-bulk-'||n from generate_series(1,205) n",
  );
  await db.query(
    "insert into user_credentials(user_id,email,password_hash) select id,'bulk-'||id||'@example.test','synthetic-bulk-hash' from users where username is null",
  );
  const users = await access.list(owner);
  assert.equal(users.length, 200);
  assert.equal(JSON.stringify(users).includes("password_hash"), false);
  assert.equal(JSON.stringify(users).includes("synthetic-bulk-hash"), false);
  assert.ok(BigInt(users[0]!.id) > BigInt(users[199]!.id));
  for (const invalid of ["0", "-1", "1;select 1", "9223372036854775808"])
    await assert.rejects(access.info(invalid), status(400));
  await assert.rejects(access.bootstrapAdmin(""), status(400));
  await assert.rejects(
    access.changePassword(owner, "old", "new", "token"),
    status(400),
  );
});
