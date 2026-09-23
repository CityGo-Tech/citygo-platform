import assert from "node:assert/strict";

// A test assertion, not a deploy approval: Docker CLI success alone is insufficient.
// Inspect the SAME process incarnation before any restart/removal loses evidence.
export function assertCleanContainerStop(before, after) {
  assert.match(before?.Id ?? "", /^[a-f0-9]{64}$/);
  assert.match(before?.Image ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(before.State.Status, "running");
  assert.equal(before.State.Running, true);
  assert.equal(before.State.Paused, false);
  assert.equal(before.State.Restarting, false);
  assert.ok(Number.isInteger(before.RestartCount) && before.RestartCount >= 0);
  assert.ok(Number.isFinite(Date.parse(before.State.StartedAt)));
  assert.equal(after?.Id, before.Id);
  assert.equal(after.Image, before.Image);
  assert.equal(after.RestartCount, before.RestartCount);
  assert.equal(after.State.StartedAt, before.State.StartedAt);
  assert.equal(after.State.Status, "exited");
  assert.equal(after.State.Running, false);
  assert.equal(after.State.Paused, false);
  assert.equal(after.State.Restarting, false);
  assert.equal(after.State.OOMKilled, false);
  assert.equal(after.State.Error, "");
  assert.equal(after.State.ExitCode, 0);
  assert.ok(
    Date.parse(after.State.FinishedAt) >= Date.parse(before.State.StartedAt),
  );
}
