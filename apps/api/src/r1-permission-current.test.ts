import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { tokenHash } from "./auth.js";
import {
  prepareR1SyntheticNotice,
  R1SyntheticNoticeRegistry,
} from "./r1-permission-planner.js";
import {
  r1SyntheticPermissionSnapshotSchema,
  r1SyntheticPermissionWriteResponseSchema,
} from "@citygo/contracts";
import {
  permissionHttpFixture,
  syntheticGrant,
  syntheticRevoke,
  syntheticRoute,
  syntheticContext,
  syntheticAi,
  syntheticRegistry,
} from "./r1-permission-http.fixture.js";
function registry(context = syntheticContext, ai = syntheticAi) {
  return new R1SyntheticNoticeRegistry({
    notices: [context, ai],
    current: { citygo_context: context.reference, ai_transfer: ai.reference },
  });
}
test("current route absent by default; missing/revoked session cannot read or select an owner", async (t) => {
  const disabled = await permissionHttpFixture(t, { enabled: false });
  assert.equal((await disabled.current("")).statusCode, 404);
  const f = await permissionHttpFixture(t);
  assert.equal((await f.current("missing", "?ownerId=other")).statusCode, 401);
  const user = await f.person();
  await f.repo.logout(tokenHash(user.token));
  assert.equal((await f.current(user.token)).statusCode, 401);
});
test("initial snapshot contains both exact fixture texts, zero decisions, no real admission or writes", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const response = await f.current(user.token);
  assert.equal(response.statusCode, 200, response.body);
  const snapshot = r1SyntheticPermissionSnapshotSchema.parse(response.json());
  assert.equal(snapshot.ownerId, user.id);
  assert.equal(snapshot.configurationRevision, 2);
  assert.equal(
    snapshot.scopes.citygo_context.notice!.definition.body,
    syntheticContext.definition.body,
  );
  assert.equal(
    snapshot.scopes.ai_transfer.notice!.reference.id,
    syntheticAi.reference.id,
  );
  for (const state of Object.values(snapshot.scopes)) {
    assert.equal(state.revision, 0);
    assert.equal(state.lastDecision, null);
    assert.equal(state.resolution, "not_decided");
    assert.equal(state.grantAvailability, "available_fixture");
  }
  assert.equal(snapshot.scopes.citygo_context.route, null);
  assert.deepEqual(snapshot.scopes.ai_transfer.route, syntheticRoute);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(await f.counts(), {
    commands: 0,
    decisions: 0,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});
test("snapshot is owner scoped, ignores a forged header and rejects all query parameters", async (t) => {
  const f = await permissionHttpFixture(t);
  const a = await f.person();
  const b = await f.person();
  const saved = await f.call(a.token, syntheticGrant());
  assert.equal(saved.statusCode, 200);
  const snapshot = (
    await f.current(b.token, "", { "x-owner-id": a.id })
  ).json();
  assert.equal(snapshot.ownerId, b.id);
  assert.equal(snapshot.scopes.citygo_context.lastDecision, null);
  for (const suffix of [
    "?ownerId=" + a.id,
    "?scope=citygo_context",
    "?noticeId=" + syntheticContext.reference.id,
    "?configurationRevision=1",
    "?ownerId=a&ownerId=b",
  ])
    assert.equal((await f.current(b.token, suffix)).statusCode, 400);
  const cookie = await f.current("", "", {
    authorization: "",
    cookie: "citygo=" + a.token,
  });
  assert.equal(cookie.statusCode, 200, cookie.body);
  assert.equal(cookie.json().ownerId, a.id);
  assert.equal(
    cookie.json().scopes.citygo_context.lastDecision.eventId,
    saved.json().receipt.eventId,
  );
});
test("replaying historical grant after revoke cannot resurrect current resolution", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const command = syntheticGrant();
  const granted = await f.call(user.token, command);
  assert.equal(
    r1SyntheticPermissionWriteResponseSchema.safeParse(granted.json()).success,
    true,
  );
  assert.equal(
    (await f.current(user.token)).json().scopes.citygo_context.resolution,
    "current_fixture_grant",
  );
  const revoked = await f.call(
    user.token,
    syntheticRevoke("citygo_context", 1),
  );
  assert.equal(revoked.statusCode, 200);
  const replay = await f.call(user.token, command);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().receipt.command.action, "grant");
  const state = (await f.current(user.token)).json().scopes.citygo_context;
  assert.equal(state.resolution, "revoked");
  assert.equal(state.revision, 2);
  assert.equal(state.lastDecision.eventId, revoked.json().receipt.eventId);
  assert.equal(state.lastDecision.command.action, "revoke");
});
test("changing notice or route requires a new action, without rewriting the saved receipt", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const saved = await f.call(user.token, syntheticGrant());
  const aiSaved = await f.call(user.token, syntheticGrant("ai_transfer"));
  const newContext = prepareR1SyntheticNotice({
    ...syntheticContext.definition,
    version: "fixture-v2",
    body: "Different complete synthetic text. Not a legal notice.",
  });
  assert.equal(
    (
      await f.control.replaceConfiguration(2, registry(newContext), {
        ...syntheticRoute,
        revision: 3,
      })
    ).status,
    "configuration_updated",
  );
  const snapshot = (await f.current(user.token)).json();
  assert.equal(snapshot.configurationRevision, 3);
  for (const scope of ["citygo_context", "ai_transfer"]) {
    assert.equal(snapshot.scopes[scope].resolution, "requires_new_action");
    assert.equal(snapshot.scopes[scope].grantAvailability, "available_fixture");
  }
  assert.deepEqual(
    snapshot.scopes.citygo_context.lastDecision,
    saved.json().receipt,
  );
  assert.deepEqual(
    snapshot.scopes.ai_transfer.lastDecision,
    aiSaved.json().receipt,
  );
  assert.equal(
    snapshot.scopes.citygo_context.notice.definition.body,
    newContext.definition.body,
  );
});
test("AI disable/withdrawal does not invalidate context; neither causes automatic re-grant", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  await f.call(user.token, syntheticGrant());
  await f.call(user.token, syntheticGrant("ai_transfer"));
  await f.control.replaceConfiguration(2, syntheticRegistry, null);
  let snapshot = (await f.current(user.token)).json();
  assert.equal(
    snapshot.scopes.citygo_context.resolution,
    "current_fixture_grant",
  );
  assert.equal(snapshot.scopes.ai_transfer.resolution, "requires_new_action");
  assert.equal(
    snapshot.scopes.ai_transfer.grantAvailability,
    "route_unavailable",
  );
  const withdrawn = prepareR1SyntheticNotice({
    ...syntheticAi.definition,
    status: "withdrawn_fixture",
  });
  await f.control.replaceConfiguration(
    3,
    registry(syntheticContext, withdrawn),
    { ...syntheticRoute, revision: 3 },
  );
  snapshot = (await f.current(user.token)).json();
  assert.equal(
    snapshot.scopes.ai_transfer.notice.definition.status,
    "withdrawn_fixture",
  );
  assert.equal(
    snapshot.scopes.ai_transfer.grantAvailability,
    "notice_not_approved",
  );
  assert.equal(snapshot.scopes.ai_transfer.resolution, "requires_new_action");
  await f.call(user.token, syntheticRevoke("ai_transfer", 1));
  snapshot = (await f.current(user.token)).json();
  assert.equal(snapshot.scopes.ai_transfer.resolution, "revoked");
  assert.deepEqual(await f.counts(), {
    commands: 3,
    decisions: 2,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});
test("no selected notices is explicit, never fallback to latest dictionary or legacy AI consent", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  await f.control.replaceConfiguration(
    2,
    new R1SyntheticNoticeRegistry({
      notices: [],
      current: { citygo_context: null, ai_transfer: null },
    }),
    null,
  );
  const snapshot = (await f.current(user.token)).json();
  for (const state of Object.values(snapshot.scopes) as {
    notice: unknown;
    resolution: string;
    grantAvailability: string;
  }[]) {
    assert.equal(state.notice, null);
    assert.equal(state.resolution, "not_decided");
    assert.equal(state.grantAvailability, "notice_unavailable");
  }
});
test("readiness remains required on GET and filled command quota never blocks reads", async (t) => {
  const f = await permissionHttpFixture(t, { quota: 1 });
  const user = await f.person();
  await f.call(user.token, syntheticGrant());
  assert.equal((await f.current(user.token)).statusCode, 200);
  await f.base.exec(
    "revoke update (id) on cg018_synthetic.runtime from " + f.roles.citygo_api,
  );
  const denied = await f.current(user.token);
  assert.equal(denied.statusCode, 503);
  assert.deepEqual(denied.json(), {
    status: "rejected",
    code: "STORE_NOT_READY",
  });
  assert.equal((await f.counts())!.commands, 1);
});
test("corrupt own record is unavailable, while another owner's corrupt history is neither decoded nor leaked", async (t) => {
  const f = await permissionHttpFixture(t);
  const a = await f.person();
  const b = await f.person();
  await f.call(a.token, syntheticGrant());
  await f.call(b.token, syntheticGrant());
  await f.base.exec(
    "alter table cg018_synthetic.commands disable trigger commands_immutable",
  );
  await f.base.query(
    "update cg018_synthetic.commands set command=$1::jsonb where owner_id=$2",
    [
      JSON.stringify({ privateText: "synthetic-private-history-never-echo" }),
      b.id,
    ],
  );
  await f.base.exec(
    "alter table cg018_synthetic.commands enable trigger commands_immutable",
  );
  assert.equal((await f.current(a.token)).statusCode, 200);
  const failed = await f.current(b.token);
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), {
    status: "rejected",
    code: "STORED_DATA_INVALID",
  });
  assert.equal(failed.body.includes("synthetic-private"), false);
});
test("tampered current notice fails without returning its text, but revoke still needs no current notice", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  await f.call(user.token, syntheticGrant());
  await f.base.exec(
    "alter table cg018_synthetic.configurations disable trigger configurations_immutable",
  );
  await f.base.query(
    "update cg018_synthetic.configurations set snapshot=jsonb_set(snapshot,'{notices,0,definition,body}',to_jsonb($1::text)) where revision=2",
    ["synthetic-tampered-notice-never-echo"],
  );
  await f.base.exec(
    "alter table cg018_synthetic.configurations enable trigger configurations_immutable",
  );
  const read = await f.current(user.token);
  assert.equal(read.statusCode, 503);
  assert.equal(read.body.includes("synthetic-tampered"), false);
  assert.equal(
    (await f.call(user.token, syntheticRevoke("citygo_context", 1))).statusCode,
    200,
  );
});
test("read driver failure reports unavailable, never empty/revoked or ambiguous command success", async (t) => {
  const f = await permissionHttpFixture(t, {
    wrap: (db) => ({
      ...db,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            ...tx,
            query: async <T>(sql: string, values?: unknown[]) => {
              if (
                sql.startsWith("select owner_id,scope,revision,event_id::text")
              )
                throw new Error("synthetic-SQL-diagnostic-never-echo");
              return tx.query<T>(sql, values);
            },
          }),
        ),
    }),
  });
  const user = await f.person();
  const read = await f.current(user.token);
  assert.equal(read.statusCode, 503);
  assert.deepEqual(read.json(), {
    status: "unavailable",
    code: "STORAGE_UNAVAILABLE",
  });
  assert.equal((await f.counts())!.commands, 0);
});
test("session change cannot use a checkpoint owner to select another snapshot", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const other = await f.person();
  const otherSession = randomUUID();
  await f.repo.createSession(other.id, tokenHash(otherSession));
  await f.call(user.token, syntheticGrant());
  const snapshot = (await f.current(otherSession)).json();
  assert.equal(snapshot.ownerId, other.id);
  assert.equal(snapshot.scopes.citygo_context.lastDecision, null);
});

test("lost or rolled-back decision pointer is corruption, not latest inference or an earlier grant", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const grant = await f.call(user.token, syntheticGrant());
  await f.call(user.token, syntheticRevoke("citygo_context", 1));
  await f.base.query(
    "update cg018_synthetic.decisions set revision=1,event_id=$1 where owner_id=$2",
    [grant.json().receipt.eventId, user.id],
  );
  let read = await f.current(user.token);
  assert.equal(read.statusCode, 503);
  assert.equal(read.json().code, "STORED_DATA_INVALID");
  await f.base.query(
    "delete from cg018_synthetic.decisions where owner_id=$1",
    [user.id],
  );
  read = await f.current(user.token);
  assert.equal(read.statusCode, 503);
  assert.equal(read.json().code, "STORED_DATA_INVALID");
  assert.equal((await f.counts())!.commands, 2);
});

test("rolled-back configuration pointer fails instead of selecting an obsolete notice", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  assert.equal(
    (
      await f.control.replaceConfiguration(2, syntheticRegistry, {
        ...syntheticRoute,
        revision: 3,
      })
    ).status,
    "configuration_updated",
  );
  await f.base.query(
    "update cg018_synthetic.runtime set configuration_revision=2 where id=1",
  );
  const read = await f.current(user.token);
  assert.equal(read.statusCode, 503);
  assert.equal(read.json().code, "STORED_DATA_INVALID");
  assert.equal((await f.counts())!.commands, 0);
});
