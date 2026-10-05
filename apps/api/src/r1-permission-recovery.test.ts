import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { R1SyntheticPermissionRecovery } from "./r1-permission-recovery.js";
import {
  syntheticContext,
  syntheticAi,
  syntheticRoute,
  syntheticGrant,
} from "./r1-permission-http.fixture.js";
const owner = "synthetic-owner";
function snapshot() {
  return {
    schemaVersion: 1,
    mode: "synthetic_only",
    status: "synthetic_snapshot",
    ownerId: owner,
    configurationRevision: 2,
    scopes: {
      citygo_context: {
        scope: "citygo_context",
        revision: 0,
        lastDecision: null,
        notice: syntheticContext,
        route: null,
        grantAvailability: "available_fixture",
        resolution: "not_decided",
      },
      ai_transfer: {
        scope: "ai_transfer",
        revision: 0,
        lastDecision: null,
        notice: syntheticAi,
        route: syntheticRoute,
        grantAvailability: "available_fixture",
        resolution: "not_decided",
      },
    },
  };
}
function loaded() {
  const controller = new R1SyntheticPermissionRecovery(owner, "citygo_context");
  assert.equal(
    controller.acceptRead(controller.beginRead(), 200, snapshot()),
    true,
  );
  return controller;
}
function saved(command: unknown, replayed = false) {
  return {
    status: "synthetic_recorded",
    replayed,
    receipt: {
      eventId: randomUUID(),
      ownerId: owner,
      scope: "citygo_context",
      revision: 1,
      configurationRevision: 2,
      recordedAt: "2026-10-05T00:00:00.000Z",
      command,
    },
  };
}
test("recovery needs a validated current snapshot and exact scope/revision/notice before a command", () => {
  const empty = new R1SyntheticPermissionRecovery(owner, "citygo_context");
  assert.equal(empty.beginCommand(syntheticGrant()), null);
  const client = loaded();
  for (const command of [
    syntheticGrant("ai_transfer"),
    syntheticGrant("citygo_context", 1),
    { ...syntheticGrant(), ownerId: owner },
    { ...syntheticGrant(), notice: { id: "a".repeat(64), version: "other" } },
  ])
    assert.equal(client.beginCommand(command), null);
  assert.ok(client.beginCommand(syntheticGrant()));
  assert.equal(client.beginCommand(syntheticGrant()), null);
});
test("historical write receipt never sets current grant; fresh GET is required", () => {
  const client = loaded();
  const attempt = client.beginCommand(syntheticGrant())!;
  assert.equal(
    client.acceptWrite(attempt.ticket, 200, saved(attempt.command, true)),
    true,
  );
  assert.equal(client.state().status, "recorded_need_refresh");
  assert.equal(client.state().snapshot, null);
  assert.equal(client.state().pendingCommand, null);
  assert.equal(client.beginCommand(syntheticGrant()), null);
});
test("uncertain write retries exactly the same command, never auto-rebases to current GET", () => {
  const client = loaded();
  const attempt = client.beginCommand(syntheticGrant())!;
  assert.equal(client.retryCommand(), null);
  client.acceptWrite(attempt.ticket, 503, {
    status: "unconfirmed",
    code: "STORAGE_UNAVAILABLE",
    retry: "same_command",
  });
  assert.equal(client.state().status, "uncertain");
  assert.equal(client.acceptRead(client.beginRead(), 200, snapshot()), true);
  assert.equal(client.state().canStartCommand, false);
  const retry = client.retryCommand()!;
  assert.equal(retry.command, attempt.command);
  assert.deepEqual(retry.command, attempt.command);
  assert.notEqual(retry.ticket, attempt.ticket);
  assert.equal(
    client.acceptWrite(retry.ticket, 200, saved(retry.command, true)),
    true,
  );
});
test("a rejected retry after uncertainty cannot prove the original write never committed", () => {
  const client = loaded();
  const attempt = client.beginCommand(syntheticGrant())!;
  client.acceptWrite(attempt.ticket, 0, null); // transport failure
  const retry = client.retryCommand()!;
  client.acceptWrite(retry.ticket, 503, {
    status: "rejected",
    code: "STORE_NOT_READY",
  });
  assert.equal(client.state().status, "uncertain");
  assert.deepEqual(client.state().pendingCommand, attempt.command);
  assert.equal(client.beginCommand(syntheticGrant()), null);
});
test("first definite rejection clears pending but still requires refresh, not an optimistic revision", () => {
  const client = loaded();
  const attempt = client.beginCommand(syntheticGrant())!;
  assert.equal(
    client.acceptWrite(attempt.ticket, 409, {
      status: "rejected",
      code: "REVISION_CONFLICT",
    }),
    true,
  );
  assert.equal(client.state().status, "rejected_need_refresh");
  assert.equal(client.state().pendingCommand, null);
  assert.equal(client.state().snapshot, null);
});
test("late GET and write replies cannot overwrite newer requests or settle the wrong pending command", () => {
  const client = loaded();
  const oldRead = client.beginRead();
  const newRead = client.beginRead();
  assert.equal(client.acceptRead(oldRead, 200, snapshot()), false);
  assert.equal(client.acceptRead(newRead, 200, snapshot()), true);
  const staleRead = client.beginRead();
  assert.equal(client.beginCommand(syntheticGrant()), null); // read invalidates cached view
  client.acceptRead(staleRead, 200, snapshot());
  const attempt = client.beginCommand(syntheticGrant())!;
  const inflightRead = client.beginRead();
  client.acceptWrite(attempt.ticket, 0, null);
  const retry = client.retryCommand()!;
  assert.equal(
    client.acceptWrite(attempt.ticket, 200, saved(attempt.command)),
    false,
  );
  assert.equal(client.acceptRead(inflightRead, 200, snapshot()), false);
  assert.ok(client.state().pendingCommand);
  assert.equal(
    client.acceptWrite(retry.ticket, 200, saved(retry.command, true)),
    true,
  );
});
test("wrong owner/command, malformed envelope or HTTP/body mismatch keeps result uncertain", () => {
  for (const change of ["owner", "command", "extra", "status"] as const) {
    const client = loaded();
    const attempt = client.beginCommand(syntheticGrant())!;
    const response = saved(attempt.command);
    if (change === "owner") response.receipt.ownerId = "other-owner";
    if (change === "command") response.receipt.command = syntheticGrant();
    const body =
      change === "extra" ? { ...response, approved: true } : response;
    assert.equal(
      client.acceptWrite(attempt.ticket, change === "status" ? 503 : 200, body),
      false,
    );
    assert.equal(client.state().status, "uncertain");
    assert.ok(client.state().pendingCommand);
  }
});
test("foreign/malformed/failed GET never becomes an empty or revoked snapshot", () => {
  const client = loaded();
  for (const body of [
    { ...snapshot(), ownerId: "other" },
    { ...snapshot(), approved: true },
    { status: "unavailable", code: "STORAGE_UNAVAILABLE" },
    null,
  ]) {
    assert.equal(client.acceptRead(client.beginRead(), 200, body), false);
    assert.equal(client.state().snapshot, null);
    assert.equal(client.state().status, "unavailable");
  }
  assert.equal(client.acceptRead(client.beginRead(), 503, snapshot()), false);
});
test("explicit checkpoint restore is owner/scope bound, immutable and requires caller retry", () => {
  const client = loaded();
  const attempt = client.beginCommand(syntheticGrant())!;
  const checkpoint = client.checkpoint()!;
  const restored = new R1SyntheticPermissionRecovery(owner, "citygo_context");
  assert.equal(
    restored.restorePending(JSON.parse(JSON.stringify(checkpoint))),
    true,
  );
  assert.equal(restored.state().status, "uncertain");
  assert.equal(restored.retryCommand(), null);
  assert.equal(
    restored.acceptRead(restored.beginRead(), 200, snapshot()),
    true,
  );
  assert.equal(restored.retryCommand(), null);
  assert.deepEqual(
    restored.retryCommand({
      requestId: attempt.command.requestId,
      notice: syntheticContext.reference,
    })!.command,
    attempt.command,
  );
  assert.equal(
    new R1SyntheticPermissionRecovery("other", "citygo_context").restorePending(
      checkpoint,
    ),
    false,
  );
  assert.equal(
    new R1SyntheticPermissionRecovery(owner, "ai_transfer").restorePending(
      checkpoint,
    ),
    false,
  );
  assert.equal(
    new R1SyntheticPermissionRecovery(owner, "citygo_context").restorePending({
      ...checkpoint,
      token: "synthetic-token",
    }),
    false,
  );
  assert.throws(() => {
    (checkpoint.command as { requestId: string }).requestId = randomUUID();
  }, TypeError);
  assert.throws(() => {
    (restored as { ownerId: string }).ownerId = "other";
  }, TypeError);
});

test("opaque read/write tickets never cross same-owner instances or survive serialization", () => {
  const a = loaded();
  const b = loaded();
  const old = a.beginRead();
  const own = b.beginRead();
  assert.equal(b.acceptRead(old, 200, snapshot()), false);
  assert.equal(
    b.acceptRead(JSON.parse(JSON.stringify(own)), 200, snapshot()),
    false,
  );
  assert.equal(b.acceptRead(own, 200, snapshot()), true);
  const first = a.beginRead();
  a.acceptRead(first, 200, snapshot());
  const sendA = a.beginCommand(syntheticGrant())!;
  const sendB = b.beginCommand(syntheticGrant())!;
  assert.equal(b.acceptWrite(sendA.ticket, 200, saved(sendB.command)), false);
  assert.equal(b.state().status, "sending");
});

test("lookup absence/refusal cannot abandon uncertainty, while an exact receipt resolves it without a write", () => {
  const client = loaded();
  const send = client.beginCommand(syntheticGrant())!;
  assert.equal(client.beginLookup(), null);
  client.acceptWrite(send.ticket, 0, null);
  for (const body of [
    {
      status: "not_recorded_at_read",
      ownerId: owner,
      scope: "citygo_context",
      requestId: send.command.requestId,
    },
    { status: "rejected", code: "STORE_NOT_READY" },
    { status: "unavailable", code: "STORAGE_UNAVAILABLE" },
    null,
  ]) {
    const read = client.beginLookup()!;
    assert.equal(client.retryCommand(), null);
    assert.equal(client.acceptLookup(read.ticket, 200, body), false);
    assert.equal(client.state().status, "uncertain");
    assert.deepEqual(client.state().pendingCommand, send.command);
  }
  const old = client.beginLookup()!;
  const latest = client.beginLookup()!;
  assert.equal(
    client.acceptLookup(old.ticket, 200, saved(send.command, true)),
    false,
  );
  assert.equal(
    client.acceptLookup(latest.ticket, 200, saved(send.command, true)),
    true,
  );
  assert.equal(client.state().status, "recorded_need_refresh");
  assert.equal(client.state().snapshot, null);
  assert.equal(client.state().pendingCommand, null);
});

test("restored grant requires fresh matching revision/text/route plus explicit confirmation", () => {
  const original = loaded();
  const send = original.beginCommand(syntheticGrant())!;
  const checkpoint = original.checkpoint();
  const restore = () => {
    const value = new R1SyntheticPermissionRecovery(owner, "citygo_context");
    assert.equal(value.restorePending(checkpoint), true);
    return value;
  };
  const client = restore();
  const confirm = {
    requestId: send.command.requestId,
    notice: syntheticContext.reference,
  };
  assert.equal(client.retryCommand(confirm), null);
  client.acceptRead(client.beginRead(), 200, snapshot());
  assert.equal(
    client.retryCommand({ ...confirm, requestId: randomUUID() }),
    null,
  );
  assert.equal(
    client.retryCommand({
      ...confirm,
      notice: { ...confirm.notice, id: "c".repeat(64) },
    }),
    null,
  );
  assert.deepEqual(client.retryCommand(confirm)!.command, send.command);
  const changed = restore();
  const current = {
    ...snapshot(),
    scopes: {
      ...snapshot().scopes,
      citygo_context: {
        ...snapshot().scopes.citygo_context,
        notice: null,
        grantAvailability: "notice_unavailable",
      },
    },
  };
  changed.acceptRead(changed.beginRead(), 200, current);
  assert.equal(changed.retryCommand(confirm), null);
  assert.equal(changed.state().status, "uncertain");
  const revoke = new R1SyntheticPermissionRecovery(owner, "citygo_context");
  revoke.restorePending({
    schemaVersion: 1,
    mode: "synthetic_only",
    ownerId: owner,
    command: {
      schemaVersion: 1,
      requestId: randomUUID(),
      expectedRevision: 0,
      scope: "citygo_context",
      action: "revoke",
    },
  });
  assert.ok(revoke.retryCommand()); // Withdrawal never needs a current text.
});

test("restored AI grant rejects stale routes/revisions and lookup rejects foreign or altered receipts and closed callbacks", () => {
  const client = new R1SyntheticPermissionRecovery(owner, "ai_transfer");
  const command = syntheticGrant("ai_transfer");
  const checkpoint = {
    schemaVersion: 1,
    mode: "synthetic_only",
    ownerId: owner,
    command,
  };
  const confirm = {
    requestId: command.requestId,
    notice: command.notice,
    route: syntheticRoute,
  };
  assert.equal(client.restorePending(checkpoint), true);
  assert.equal(client.retryCommand(confirm), null);
  const stale = snapshot();
  stale.scopes.ai_transfer.route = { ...syntheticRoute, revision: 3 };
  client.acceptRead(client.beginRead(), 200, stale);
  assert.equal(client.retryCommand(confirm), null);
  client.acceptRead(client.beginRead(), 200, snapshot());
  assert.equal(
    client.retryCommand({
      ...confirm,
      route: { ...syntheticRoute, revision: 3 },
    }),
    null,
  );
  assert.equal(
    client.retryCommand({
      requestId: command.requestId,
      notice: command.notice,
    }),
    null,
  );
  const read = client.beginLookup()!;
  const other = new R1SyntheticPermissionRecovery(owner, "ai_transfer");
  other.restorePending(checkpoint);
  const otherRead = other.beginLookup()!;
  assert.equal(
    client.acceptLookup(otherRead.ticket, 200, saved(command, true)),
    false,
  );
  const foreign = saved(command, true);
  foreign.receipt.ownerId = "foreign-owner";
  assert.equal(client.acceptLookup(read.ticket, 200, foreign), false);
  const altered = saved({ ...command, requestId: randomUUID() }, true);
  assert.equal(
    client.acceptLookup(client.beginLookup()!.ticket, 200, altered),
    false,
  );
  client.acceptRead(client.beginRead(), 200, snapshot());
  const retry = client.retryCommand(confirm)!;
  assert.deepEqual(retry.command, command);
  client.acceptWrite(retry.ticket, 0, null);
  const late = client.beginLookup()!;
  client.close();
  assert.equal(client.beginLookup(), null);
  assert.equal(
    client.acceptLookup(late.ticket, 200, saved(command, true)),
    false,
  );
});
test("snapshot/command mutation cannot change an in-flight request or grant unknown fixture", () => {
  const client = loaded();
  const state = client.state();
  assert.throws(() => {
    state.snapshot!.scopes.citygo_context.revision = 9;
  }, TypeError);
  const input = syntheticGrant();
  const attempt = client.beginCommand(input)!;
  input.requestId = randomUUID();
  assert.notEqual(attempt.command.requestId, input.requestId);
  const unavailable = snapshot();
  unavailable.scopes.citygo_context.grantAvailability = "notice_not_approved";
  unavailable.scopes.citygo_context.notice = {
    ...syntheticContext,
    definition: { ...syntheticContext.definition, status: "withdrawn_fixture" },
  };
  const blocked = new R1SyntheticPermissionRecovery(owner, "citygo_context");
  assert.equal(blocked.acceptRead(blocked.beginRead(), 200, unavailable), true);
  assert.equal(blocked.beginCommand(syntheticGrant()), null);
});

test("terminal close clears the local snapshot and ignores a late read without reopening", () => {
  for (const loading of [false, true]) {
    const client = loaded();
    const ticket = loading ? client.beginRead() : null;
    client.close();
    client.close(); // Idempotent and terminal, not reset to an empty session.
    assert.deepEqual(client.state(), {
      status: "closed",
      snapshot: null,
      pendingCommand: null,
      canStartCommand: false,
    });
    if (ticket !== null)
      assert.equal(client.acceptRead(ticket, 200, snapshot()), false);
    assert.throws(
      () => client.beginRead(),
      /Synthetic recovery session closed/,
    );
    assert.equal(client.beginCommand(syntheticGrant()), null);
    assert.equal(client.retryCommand(), null);
    assert.equal(client.state().status, "closed");
  }
});

test("close ignores late acknowledgement and checkpoint restore in both sending and uncertain states", () => {
  for (const uncertain of [false, true]) {
    const client = loaded();
    const attempt = client.beginCommand(syntheticGrant())!;
    const checkpoint = client.checkpoint()!;
    if (uncertain) client.acceptWrite(attempt.ticket, 0, null);
    client.close();
    assert.equal(client.checkpoint(), null);
    assert.equal(client.state().pendingCommand, null);
    assert.equal(
      client.acceptWrite(attempt.ticket, 200, saved(attempt.command)),
      false,
    );
    assert.equal(client.restorePending(checkpoint), false);
    assert.equal(client.retryCommand(), null);
    assert.equal(client.state().status, "closed");
    // External checkpoints are NOT erased by close. Restoration needs a new,
    // explicitly authenticated instance and remains uncertain, not approved.
    const replacement = new R1SyntheticPermissionRecovery(
      owner,
      "citygo_context",
    );
    assert.equal(replacement.restorePending(checkpoint), true);
    assert.equal(replacement.state().status, "uncertain");
  }
});
