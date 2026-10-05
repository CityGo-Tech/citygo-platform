import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readConfig } from "@citygo/config";
import type { Database, Sql } from "@citygo/db";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { verifyR1SyntheticPermissionReadiness } from "./r1-permission-access.js";
import {
  permissionHttpFixture,
  syntheticPermissionPath,
  syntheticGrant,
  syntheticRevoke,
  syntheticRegistry,
} from "./r1-permission-http.fixture.js";

test("permission routes absent by default; test flag cannot activate production/development", async (t) => {
  const f = await permissionHttpFixture(t, { enabled: false });
  assert.equal((await f.call("", syntheticGrant())).statusCode, 404);
  assert.equal(
    (await f.lookup("", "citygo_context", randomUUID())).statusCode,
    404,
  );
  for (const NODE_ENV of ["production", "development"] as const)
    await assert.rejects(
      buildApp({
        db: f.db,
        testing: true,
        config: { ...readConfig({ NODE_ENV: "test" }), NODE_ENV },
        syntheticPermissions: {},
      }),
      /synthetic test harness/,
    );
  await assert.rejects(
    buildApp({
      db: f.db,
      config: readConfig({ NODE_ENV: "test" }),
      syntheticPermissions: {},
    }),
    /synthetic test harness/,
  );
});

test("authenticated bearer/cookie commands store only synthetic records and replay a historical receipt", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const command = syntheticGrant();
  const first = await f.call(user.token, command);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().receipt.ownerId, user.id);
  assert.equal(first.json().status, "synthetic_recorded");
  const revoke = await f.call(
    user.token,
    syntheticRevoke("citygo_context", 1),
    {
      authorization: "",
      cookie: "citygo=" + user.token,
    },
  );
  assert.equal(revoke.statusCode, 200, revoke.body);
  const replay = await f.call(user.token, command);
  assert.equal(replay.json().replayed, true);
  assert.deepEqual(replay.json().receipt, first.json().receipt);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.deepEqual(await f.counts(), {
    commands: 2,
    decisions: 1,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});

test("expired, logged-out and blocked sessions cannot write; anonymous fails before readiness", async (t) => {
  const f = await permissionHttpFixture(t, { grants: false });
  assert.equal((await f.call("missing", syntheticGrant())).statusCode, 401);
  const expired = await f.person();
  await f.base.query(
    "update sessions set expires_at=now()-interval '1 second' where token_hash=$1",
    [tokenHash(expired.token)],
  );
  assert.equal((await f.call(expired.token, syntheticGrant())).statusCode, 401);
  const loggedOut = await f.person();
  await f.repo.logout(tokenHash(loggedOut.token));
  assert.equal(
    (await f.call(loggedOut.token, syntheticGrant())).statusCode,
    401,
  );
  const blocked = await f.person();
  await f.base.query("update users set status='blocked' where id=$1", [
    blocked.id,
  ]);
  assert.equal((await f.call(blocked.token, syntheticGrant())).statusCode, 401);
  assert.equal((await f.counts())!.commands, 0);
});

test("cookie requires same-origin even with native spoof; valid bearer permits missing origin only", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const inject = (
    headers: Record<string, string>,
    payload = syntheticGrant(),
  ) =>
    f.app.inject({
      method: "POST",
      url: syntheticPermissionPath,
      payload,
      headers: { "X-CityGo-Contract-Version": "1", ...headers },
    });
  for (const origin of [undefined, "http://evil.example.test", "null"])
    assert.equal(
      (
        await inject({
          cookie: "citygo=" + user.token,
          "x-citygo-client": "native",
          ...(origin === undefined ? {} : { origin }),
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await inject({
        authorization: "Bearer missing",
        cookie: "citygo=" + user.token,
        "x-citygo-client": "native",
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await inject({
        authorization: "Bearer " + user.token,
        origin: "http://evil.example.test",
      })
    ).statusCode,
    403,
  );
  const bearer = await inject({ authorization: "Bearer " + user.token });
  assert.equal(bearer.statusCode, 200, bearer.body);
  assert.equal((await f.counts())!.commands, 1);
});

test("owner cannot be supplied in wire input; owners and scopes have separate replay keys", async (t) => {
  const f = await permissionHttpFixture(t);
  const a = await f.person();
  const b = await f.person();
  const command = syntheticGrant();
  assert.equal(
    (await f.call(a.token, { ...command, ownerId: b.id })).statusCode,
    400,
  );
  assert.equal(
    (await f.call(a.token, { ...command, timestamp: new Date().toISOString() }))
      .statusCode,
    400,
  );
  const first = await f.call(a.token, command);
  const other = await f.call(b.token, command);
  assert.equal(other.statusCode, 200, other.body);
  assert.equal(other.json().receipt.ownerId, b.id);
  assert.notEqual(other.json().receipt.eventId, first.json().receipt.eventId);
  const ai = await f.call(a.token, {
    ...syntheticGrant("ai_transfer"),
    requestId: command.requestId,
  });
  assert.equal(ai.statusCode, 200, ai.body);
  const reused = await f.call(a.token, { ...command, expectedRevision: 1 });
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.json().code, "REQUEST_ID_REUSED");
  assert.deepEqual(await f.counts(), {
    commands: 3,
    decisions: 3,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});

test("missing grants and elevated role reject without writes; readiness does not reveal diagnostics", async (t) => {
  const f = await permissionHttpFixture(t, { grants: false });
  const user = await f.person();
  const response = await f.call(user.token, syntheticGrant());
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "rejected",
    code: "STORE_NOT_READY",
  });
  assert.equal(
    await f.base.transaction(verifyR1SyntheticPermissionReadiness),
    false,
  );
  assert.equal((await f.counts())!.commands, 0);
});

test("readiness checks effective column grants every request, including unsafe extra rights", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const mutations = [
    [
      "grant update (mode) on cg018_synthetic.runtime",
      "revoke update (mode) on cg018_synthetic.runtime",
    ],
    [
      "grant insert on cg018_synthetic.configurations",
      "revoke insert on cg018_synthetic.configurations",
    ],
    [
      "grant insert (recorded_at) on cg018_synthetic.commands",
      "revoke insert (recorded_at) on cg018_synthetic.commands",
    ],
    [
      "grant delete on cg018_synthetic.decisions",
      "revoke delete on cg018_synthetic.decisions",
    ],
    [
      "grant create on schema cg018_synthetic",
      "revoke create on schema cg018_synthetic",
    ],
  ];
  for (const [unsafe, undo] of mutations) {
    await f.base.exec(unsafe + " to " + f.roles.citygo_api);
    const response = await f.call(user.token, syntheticGrant());
    assert.equal(response.statusCode, 503, response.body);
    await f.base.exec(undo + " from " + f.roles.citygo_api);
  }
  await f.base.exec(
    "revoke update (id) on cg018_synthetic.runtime from " + f.roles.citygo_api,
  );
  assert.equal((await f.call(user.token, syntheticGrant())).statusCode, 503);
  await f.base.exec(
    "grant update (id) on cg018_synthetic.runtime to " + f.roles.citygo_api,
  );
  assert.equal((await f.call(user.token, syntheticGrant())).statusCode, 200);
  assert.equal((await f.counts())!.commands, 1);
});

test("HTTP role cannot change configuration, dictionary/history, event timestamp or decision owner", async (t) => {
  const f = await permissionHttpFixture(t);
  for (const sql of [
    "update cg018_synthetic.runtime set configuration_revision=1",
    "insert into cg018_synthetic.configurations (revision,snapshot) values (3,'{}')",
    "delete from cg018_synthetic.commands",
    "update cg018_synthetic.notices set record='{}'",
    "update cg018_synthetic.decisions set owner_id='other'",
    "truncate cg018_synthetic.commands cascade",
  ])
    await assert.rejects(f.scoped.query(sql));
  assert.deepEqual(await f.counts(), {
    commands: 0,
    decisions: 0,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});

test("missing key constraints or disabled history triggers fail closed before writes", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  await f.base.exec(
    "alter table cg018_synthetic.commands disable trigger commands_immutable",
  );
  assert.equal((await f.call(user.token, syntheticGrant())).statusCode, 503);
  await f.base.exec(
    "alter table cg018_synthetic.commands enable trigger commands_immutable",
  );
  await f.base.exec(
    "alter table cg018_synthetic.decisions drop constraint decisions_owner_id_scope_revision_event_id_fkey",
  );
  assert.equal((await f.call(user.token, syntheticGrant())).statusCode, 503);
  assert.equal((await f.counts())!.commands, 0);
});

test("owner quota spans sessions and scopes; replay and both withdrawals remain available at capacity", async (t) => {
  const f = await permissionHttpFixture(t, { quota: 2 });
  const user = await f.person();
  const anotherSession = randomUUID();
  await f.repo.createSession(user.id, tokenHash(anotherSession));
  const context = syntheticGrant();
  const ai = syntheticGrant("ai_transfer");
  assert.equal((await f.call(user.token, context)).statusCode, 200);
  assert.equal((await f.call(anotherSession, ai)).statusCode, 200);
  const overflow = await f.call(
    anotherSession,
    syntheticGrant("citygo_context", 1),
  );
  assert.equal(overflow.statusCode, 429);
  assert.equal(overflow.json().code, "STORAGE_QUOTA_EXCEEDED");
  const replay = await f.call(anotherSession, context);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  // Withdrawal needs neither loading nor accepting current fixture text.
  await f.base.exec(
    "alter table cg018_synthetic.configurations disable trigger configurations_immutable",
  );
  await f.base.query(
    "update cg018_synthetic.configurations set snapshot='{}' where revision=2",
  );
  await f.base.exec(
    "alter table cg018_synthetic.configurations enable trigger configurations_immutable",
  );
  for (const scope of ["citygo_context", "ai_transfer"] as const) {
    assert.equal(
      (await f.call(user.token, syntheticRevoke(scope, 1))).statusCode,
      200,
    );
    assert.equal(
      (await f.call(user.token, syntheticRevoke(scope, 2))).statusCode,
      429,
    );
  }
  assert.deepEqual(await f.counts(), {
    commands: 4,
    decisions: 2,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});

test("commit acknowledgement loss reports unconfirmed; identical retry returns one saved event", async (t) => {
  let loseOnce = true;
  const wrap = (db: Database): Database => ({
    ...db,
    async transaction(work) {
      let wrote = false;
      const result = await db.transaction((tx) =>
        work({
          ...tx,
          async query<T>(sql: string, values?: unknown[]) {
            const result = await tx.query<T>(sql, values);
            if (sql.includes("insert into cg018_synthetic.decisions"))
              wrote = true;
            return result;
          },
        } as Sql),
      );
      if (wrote && loseOnce) {
        loseOnce = false;
        throw new Error("synthetic-secret-SQL-never-echo");
      }
      return result;
    },
  });
  const f = await permissionHttpFixture(t, { wrap });
  const user = await f.person();
  const command = syntheticGrant();
  const first = await f.call(user.token, command);
  assert.equal(first.statusCode, 503, first.body);
  assert.deepEqual(first.json(), {
    status: "unconfirmed",
    code: "STORAGE_UNAVAILABLE",
    retry: "same_command",
  });
  assert.equal(first.body.includes("synthetic-secret"), false);
  const retry = await f.call(user.token, command);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().replayed, true);
  assert.equal((await f.counts())!.commands, 1);
});

test("stale notice/revision/route rejected, independent revoke survives fixture withdrawal", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const ai = syntheticGrant("ai_transfer");
  assert.equal(
    (
      await f.call(user.token, {
        ...ai,
        route: { revision: 1, disclosureId: "a".repeat(64) },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.call(user.token, { ...syntheticGrant(), expectedRevision: 1 }))
      .statusCode,
    409,
  );
  assert.equal((await f.call(user.token, ai)).statusCode, 200);
  assert.equal(
    (await f.control.replaceConfiguration(2, syntheticRegistry, null)).status,
    "configuration_updated",
  );
  assert.equal(
    (await f.call(user.token, syntheticRevoke("ai_transfer", 1))).statusCode,
    200,
  );
});

test("route IP limiter rejects request 61 without creating more events", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  for (let i = 0; i < 60; i++)
    assert.equal((await f.call(user.token, { invalid: true })).statusCode, 400);
  assert.equal((await f.call(user.token, syntheticGrant())).statusCode, 429);
  assert.equal((await f.counts())!.commands, 0);
});
