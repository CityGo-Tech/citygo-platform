import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Database } from "@citygo/db";
import type { R1PermissionScope } from "@citygo/contracts";
import { tokenHash } from "./auth.js";
import { R1SyntheticPermissionRecovery } from "./r1-permission-recovery.js";
import {
  prepareR1SyntheticNotice,
  R1SyntheticNoticeRegistry,
} from "./r1-permission-planner.js";
import {
  permissionHttpFixture,
  syntheticGrant,
  syntheticRevoke,
  syntheticContext,
  syntheticAi,
  syntheticRoute,
} from "./r1-permission-http.fixture.js";

// Wire protocol integration ONLY: real synthetic HTTP/auth/role/storage with
// memory PGlite. No browser, real user, provider, .env or external connection.
test("HTTP recovery: lost commit ack, route change, another-session revoke and read-only lookup never re-grant", async (t) => {
  let lose = true;
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
        }),
      );
      if (wrote && lose) {
        lose = false;
        throw new Error("synthetic-lost-ack-never-echo");
      }
      return result;
    },
  });
  const f = await permissionHttpFixture(t, { wrap });
  const user = await f.person();
  const foreign = await f.person();
  const client = new R1SyntheticPermissionRecovery(user.id, "ai_transfer");
  const firstRead = await f.current(user.token);
  assert.equal(
    client.acceptRead(
      client.beginRead(),
      firstRead.statusCode,
      firstRead.json(),
    ),
    true,
  );
  const attempt = client.beginCommand(syntheticGrant("ai_transfer"))!;
  const firstWrite = await f.call(user.token, attempt.command);
  assert.equal(firstWrite.statusCode, 503, firstWrite.body);
  assert.equal(firstWrite.json().status, "unconfirmed");
  assert.equal(
    client.acceptWrite(
      attempt.ticket,
      firstWrite.statusCode,
      firstWrite.json(),
    ),
    false,
  );
  assert.equal((await f.counts())!.commands, 1);
  const checkpoint = JSON.parse(JSON.stringify(client.checkpoint()));
  client.close();
  const restored = new R1SyntheticPermissionRecovery(user.id, "ai_transfer");
  assert.equal(restored.restorePending(checkpoint), true);

  const registry = new R1SyntheticNoticeRegistry({
    notices: [syntheticContext, syntheticAi],
    current: {
      citygo_context: syntheticContext.reference,
      ai_transfer: syntheticAi.reference,
    },
  });
  assert.equal(
    (
      await f.control.replaceConfiguration(2, registry, {
        ...syntheticRoute,
        revision: 3,
      })
    ).status,
    "configuration_updated",
  );
  const changed = await f.current(user.token);
  assert.equal(
    restored.acceptRead(
      restored.beginRead(),
      changed.statusCode,
      changed.json(),
    ),
    true,
  );
  const originalEvent = changed.json().scopes.ai_transfer.lastDecision.eventId;
  assert.equal(
    restored.state().snapshot!.scopes.ai_transfer.resolution,
    "requires_new_action",
  );
  assert.equal(restored.state().canStartCommand, false);

  const foreignRead = await f.current(foreign.token);
  assert.equal(
    restored.acceptRead(
      restored.beginRead(),
      foreignRead.statusCode,
      foreignRead.json(),
    ),
    false,
  );
  assert.equal(restored.state().snapshot, null);
  assert.deepEqual(restored.state().pendingCommand, attempt.command);
  const secondSession = randomUUID();
  await f.repo.createSession(user.id, tokenHash(secondSession));
  const revoke = await f.call(secondSession, syntheticRevoke("ai_transfer", 1));
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.equal((await f.call(secondSession, syntheticGrant())).statusCode, 200);
  const revokedRead = await f.current(secondSession);
  assert.equal(
    restored.acceptRead(
      restored.beginRead(),
      revokedRead.statusCode,
      revokedRead.json(),
    ),
    true,
  );
  assert.equal(
    restored.state().snapshot!.scopes.ai_transfer.resolution,
    "revoked",
  );
  assert.equal(
    restored.state().snapshot!.scopes.citygo_context.resolution,
    "current_fixture_grant",
  );
  assert.equal(restored.state().canStartCommand, false);

  assert.equal(restored.retryCommand(), null);
  const lookup = restored.beginLookup()!;
  const replay = await f.lookup(secondSession, lookup.scope, lookup.requestId);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().receipt.eventId, originalEvent);
  assert.equal(replay.json().receipt.command.action, "grant");
  assert.equal(
    restored.acceptLookup(lookup.ticket, replay.statusCode, replay.json()),
    true,
  );
  assert.equal(restored.state().snapshot, null);
  assert.equal(restored.state().status, "recorded_need_refresh");
  const finalRead = await f.current(secondSession);
  assert.equal(
    restored.acceptRead(
      restored.beginRead(),
      finalRead.statusCode,
      finalRead.json(),
    ),
    true,
  );
  assert.equal(
    restored.state().snapshot!.scopes.ai_transfer.resolution,
    "revoked",
  );
  assert.equal(
    restored.state().snapshot!.scopes.ai_transfer.lastDecision!.eventId,
    revoke.json().receipt.eventId,
  );
  assert.deepEqual(await f.counts(), {
    commands: 3,
    decisions: 2,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});

test("HTTP recovery: independent withdrawals work with no selected notice or AI route", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const empty = new R1SyntheticNoticeRegistry({
    notices: [],
    current: { citygo_context: null, ai_transfer: null },
  });
  assert.equal(
    (await f.control.replaceConfiguration(2, empty, null)).status,
    "configuration_updated",
  );
  for (const scope of [
    "citygo_context",
    "ai_transfer",
  ] as const satisfies readonly R1PermissionScope[]) {
    const client = new R1SyntheticPermissionRecovery(user.id, scope);
    const read = await f.current(user.token);
    assert.equal(
      client.acceptRead(client.beginRead(), read.statusCode, read.json()),
      true,
    );
    assert.equal(client.state().snapshot!.scopes[scope].notice, null);
    assert.equal(client.beginCommand(syntheticGrant(scope)), null);
    const attempt = client.beginCommand(syntheticRevoke(scope, 0))!;
    const result = await f.call(user.token, attempt.command);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(
      client.acceptWrite(attempt.ticket, result.statusCode, result.json()),
      true,
    );
    assert.equal(client.state().snapshot, null);
    const refreshed = await f.current(user.token);
    assert.equal(
      client.acceptRead(
        client.beginRead(),
        refreshed.statusCode,
        refreshed.json(),
      ),
      true,
    );
    assert.equal(client.state().snapshot!.scopes[scope].resolution, "revoked");
  }
  assert.deepEqual(await f.counts(), {
    commands: 2,
    decisions: 2,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});

test("HTTP recovery: changed text rejects an old command; explicit refresh and new action are required", async (t) => {
  const f = await permissionHttpFixture(t);
  const user = await f.person();
  const client = new R1SyntheticPermissionRecovery(user.id, "citygo_context");
  const read = await f.current(user.token);
  client.acceptRead(client.beginRead(), read.statusCode, read.json());
  const changed = prepareR1SyntheticNotice({
    ...syntheticContext.definition,
    version: "fixture-v2",
    body: "A new synthetic full context notice, not a real policy.",
  });
  const registry = new R1SyntheticNoticeRegistry({
    notices: [changed, syntheticAi],
    current: {
      citygo_context: changed.reference,
      ai_transfer: syntheticAi.reference,
    },
  });
  await f.control.replaceConfiguration(2, registry, syntheticRoute);
  const old = client.beginCommand(syntheticGrant())!;
  const rejected = await f.call(user.token, old.command);
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().code, "NOTICE_CHANGED");
  assert.equal(
    client.acceptWrite(old.ticket, rejected.statusCode, rejected.json()),
    true,
  );
  assert.equal(client.state().status, "rejected_need_refresh");
  assert.equal(client.beginCommand(syntheticGrant()), null);
  assert.equal((await f.counts())!.commands, 0);
  const fresh = await f.current(user.token);
  assert.equal(
    client.acceptRead(client.beginRead(), fresh.statusCode, fresh.json()),
    true,
  );
  assert.equal(client.beginCommand(syntheticGrant()), null);
  const explicit = client.beginCommand({
    ...syntheticGrant(),
    notice: changed.reference,
  })!;
  assert.notEqual(explicit.command.requestId, old.command.requestId);
  const recorded = await f.call(user.token, explicit.command);
  assert.equal(recorded.statusCode, 200, recorded.body);
  assert.equal(
    client.acceptWrite(explicit.ticket, recorded.statusCode, recorded.json()),
    true,
  );
  const current = await f.current(user.token);
  assert.equal(
    client.acceptRead(client.beginRead(), current.statusCode, current.json()),
    true,
  );
  assert.equal(
    client.state().snapshot!.scopes.citygo_context.resolution,
    "current_fixture_grant",
  );
  const lateTicket = client.beginRead();
  const late = await f.current(user.token);
  await f.repo.logout(tokenHash(user.token));
  client.close();
  assert.equal(
    client.acceptRead(lateTicket, late.statusCode, late.json()),
    false,
  );
  assert.equal((await f.current(user.token)).statusCode, 401);
  assert.equal(client.state().status, "closed");
  // LOCAL close/logout is neither a server permission revoke nor erasure.
  const newSession = randomUUID();
  await f.repo.createSession(user.id, tokenHash(newSession));
  const replacement = new R1SyntheticPermissionRecovery(
    user.id,
    "citygo_context",
  );
  const again = await f.current(newSession);
  assert.equal(
    replacement.acceptRead(
      replacement.beginRead(),
      again.statusCode,
      again.json(),
    ),
    true,
  );
  assert.equal(
    replacement.state().snapshot!.scopes.citygo_context.resolution,
    "current_fixture_grant",
  );
  assert.deepEqual(await f.counts(), {
    commands: 1,
    decisions: 1,
    consents: 0,
    attempts: 0,
    xp: 0,
  });
});
