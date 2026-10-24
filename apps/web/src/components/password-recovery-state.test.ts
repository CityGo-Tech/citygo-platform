import assert from "node:assert/strict";
import test from "node:test";
import {
  createPasswordRecoveryLifetime,
  pendingPasswordRecovery,
  recoveryClock,
  recoveryCodeValid,
  recoveryPasswordError,
} from "./password-recovery-state";
test("recovery clock enforces sixty seconds and expires without extending a capability", () => {
  const pending = pendingPasswordRecovery(
    {
      challengeId: "123e4567-e89b-42d3-a456-426614174001",
      proof: "1".repeat(64),
      expiresAt: new Date(600_000).toISOString(),
      resendAfterSeconds: 0,
    },
    1000,
  );
  assert.equal(recoveryClock(pending, 1000).resendSeconds, 60);
  assert.equal(recoveryClock(pending, 60_999).resendSeconds, 1);
  assert.deepEqual(recoveryClock(pending, 600_000), {
    expired: true,
    resendSeconds: 0,
  });
  assert.equal(
    recoveryClock({ ...pending, expiresAt: "bad" }, 1).expired,
    true,
  );
});
test("password is six to128 opaque characters without trimming or composition requirements", () => {
  for (const value of ["123456", " аа!  ", "      ", "пароль", "a".repeat(128)])
    assert.equal(recoveryPasswordError(value, value), "");
  for (const value of ["12345", "a".repeat(129)])
    assert.match(recoveryPasswordError(value, value), /6 до 128/);
  assert.match(recoveryPasswordError("123456", "123457"), /не совпадают/);
  assert.equal(recoveryCodeValid("012345"), true);
  for (const value of ["12345", "1234567", " 123456", "１２３４５６"])
    assert.equal(recoveryCodeValid(value), false);
});
test("view gate excludes duplicate submits; stale finishes cannot unlock a new generation", () => {
  const parent = new AbortController(),
    scope = createPasswordRecoveryLifetime(parent.signal);
  const old = scope.begin()!;
  assert.equal(scope.begin(), null);
  scope.reset();
  const next = scope.begin()!;
  assert.equal(old.active(), false);
  assert.equal(old.signal.aborted, true);
  old.finish();
  assert.equal(scope.begin(), null);
  next.finish();
  assert.ok(scope.begin());
  scope.dispose();
});
test("parent invalidation and unmount abort requests and reject delayed success callbacks", () => {
  const parent = new AbortController(),
    scope = createPasswordRecoveryLifetime(parent.signal),
    ticket = scope.begin()!;
  parent.abort();
  assert.equal(ticket.active(), false);
  assert.equal(ticket.signal.aborted, true);
  assert.throws(() => ticket.check());
  assert.equal(scope.begin(), null);
  scope.dispose();
  const second = createPasswordRecoveryLifetime(new AbortController().signal),
    current = second.begin()!;
  second.dispose();
  assert.equal(current.active(), false);
  assert.throws(() => current.check());
});
