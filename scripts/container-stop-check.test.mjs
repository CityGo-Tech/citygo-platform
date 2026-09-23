import assert from "node:assert/strict";
import test from "node:test";
import { assertCleanContainerStop } from "./container-stop-check.mjs";

const before = {
  Id: "a".repeat(64),
  Image: "sha256:" + "b".repeat(64),
  RestartCount: 0,
  State: {
    Status: "running",
    Running: true,
    Paused: false,
    Restarting: false,
    StartedAt: "2026-09-23T12:00:00.000Z",
  },
};
const after = {
  ...before,
  State: {
    ...before.State,
    Status: "exited",
    Running: false,
    OOMKilled: false,
    ExitCode: 0,
    Error: "",
    FinishedAt: "2026-09-23T12:00:01.000Z",
  },
};

test("clean stop requires the same container and process, not Docker command success", () => {
  assert.doesNotThrow(() => assertCleanContainerStop(before, after));
});

for (const [name, change] of Object.entries({
  "application failure": { ExitCode: 1 },
  "forced SIGKILL": { ExitCode: 137 },
  "unhandled SIGTERM": { ExitCode: 143 },
  "unknown exit code": { ExitCode: null },
  "string exit code": { ExitCode: "0" },
  "OOM with zero code": { OOMKilled: true },
  "missing OOM evidence": { OOMKilled: undefined },
  "still running": { Status: "running", Running: true },
  paused: { Paused: true },
  restarting: { Restarting: true },
  dead: { Status: "dead" },
  "engine error": { Error: "synthetic failure" },
  "different start": { StartedAt: "2026-09-23T12:00:00.500Z" },
  "missing finish": { FinishedAt: undefined },
  "stale finish": { FinishedAt: "2026-09-22T12:00:00.000Z" },
})) {
  test(`rejects ${name}`, () => {
    assert.throws(() =>
      assertCleanContainerStop(before, {
        ...after,
        State: { ...after.State, ...change },
      }),
    );
  });
}
test("does not accept replacement containers, images, restarts or missing evidence", () => {
  for (const change of [
    { Id: "c".repeat(64) },
    { Image: "sha256:" + "d".repeat(64) },
    { RestartCount: 1 },
    { State: {} },
  ])
    assert.throws(() =>
      assertCleanContainerStop(before, { ...after, ...change }),
    );
  for (const invalid of [
    null,
    {},
    { ...before, RestartCount: undefined },
    { ...before, State: { ...before.State, Running: false } },
  ])
    assert.throws(() => assertCleanContainerStop(invalid, after));
});
