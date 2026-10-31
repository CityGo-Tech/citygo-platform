import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard } from "@citygo/api-client";
import {
  createLogoutDecision,
  currentLogoutConfirmation,
} from "./logout-confirmation-state";
test("stay is a one-time UI decision and never clears a draft, rotates a session or revokes", () => {
  const session = createSessionGuard();
  session.reset("1");
  const intent = { owner: "1", ticket: session.capture() };
  let draft = "Мой незавершённый текст",
    closed = 0,
    revoked = 0;
  const decision = createLogoutDecision({
    current: () =>
      currentLogoutConfirmation(intent, "1", session.capture().signal),
    onClose: () => closed++,
    onConfirm: () => {
      draft = "";
      revoked++;
      session.reset();
    },
  });
  assert.equal(decision.cancel(), true);
  assert.equal(decision.cancel(), false);
  assert.equal(decision.confirm(), false);
  assert.equal(closed, 1);
  assert.equal(revoked, 0);
  assert.equal(draft, "Мой незавершённый текст");
  assert.equal(intent.ticket.active(), true);
});
test("confirm runs the existing logout at most once and cannot act for another owner or lifetime", () => {
  const session = createSessionGuard();
  session.reset("1");
  const intent = { owner: "1", ticket: session.capture() };
  let owner = "1",
    revoked = 0;
  const decision = createLogoutDecision({
    current: () =>
      currentLogoutConfirmation(intent, owner, session.capture().signal),
    onClose: () => {},
    onConfirm: () => {
      revoked++;
      session.reset();
    },
  });
  owner = "2";
  assert.equal(decision.confirm(), false);
  owner = "1";
  assert.equal(decision.confirm(), true);
  assert.equal(decision.confirm(), false);
  assert.equal(revoked, 1);
  const stale = { owner: "1", ticket: session.capture() };
  const late = createLogoutDecision({
    current: () =>
      currentLogoutConfirmation(stale, "1", session.capture().signal),
    onClose: () => assert.fail(),
    onConfirm: () => assert.fail(),
  });
  session.reset("1");
  assert.equal(late.confirm(), false);
  assert.equal(late.cancel(), false);
  late.dispose();
});
test("disposed exit decision cannot be replayed even if its old session is still active", () => {
  const decision = createLogoutDecision({
    current: () => true,
    onClose: () => assert.fail(),
    onConfirm: () => assert.fail(),
  });
  decision.dispose();
  assert.equal(decision.confirm(), false);
  assert.equal(decision.cancel(), false);
});
