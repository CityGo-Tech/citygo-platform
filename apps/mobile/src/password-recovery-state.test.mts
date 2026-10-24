import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard } from "@citygo/api-client";
import {
  createPasswordRecoveryLifetime,
  pendingPasswordRecovery,
  recoveryClock,
  recoveryCodeValid,
  recoveryPasswordError,
} from "./password-recovery-state.js";
test("native recovery keeps proof only in ephemeral state with sixty-second resend and fixed expiry", () => {
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
});
test("native password accepts six opaque characters and refuses mismatched confirmation", () => {
  for (const value of ["123456", " аа!  ", "      ", "пароль", "a".repeat(128)])
    assert.equal(recoveryPasswordError(value, value), "");
  assert.ok(recoveryPasswordError("12345", "12345"));
  assert.ok(recoveryPasswordError("a".repeat(129), "a".repeat(129)));
  assert.ok(recoveryPasswordError("123456", "654321"));
  assert.equal(recoveryCodeValid("012345"), true);
  assert.equal(recoveryCodeValid(" 012345"), false);
});
test("native lifetime rejects double presses, late completion, owner replacement and unmount", () => {
  const parent = new AbortController(),
    scope = createPasswordRecoveryLifetime(parent.signal, createSessionGuard),
    old = scope.begin()!;
  assert.equal(scope.begin(), null);
  scope.reset();
  const next = scope.begin()!;
  old.finish();
  assert.equal(scope.begin(), null);
  assert.throws(() => old.check());
  parent.abort();
  assert.equal(next.signal.aborted, true);
  assert.equal(next.active(), false);
  assert.equal(scope.begin(), null);
  scope.dispose();
});
