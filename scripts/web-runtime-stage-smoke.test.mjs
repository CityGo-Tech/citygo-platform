import assert from "node:assert/strict";
import { test } from "node:test";
import { runControllerSmoke } from "./web-switch-controller-smoke.mjs";

test("runtime staging is an inert same-image plan and requires its own explicit fixture flag", async () => {
  const lines = [];
  const previous = console.log;
  console.log = (line) => lines.push(line);
  try {
    await runControllerSmoke(["--runtime-stage", "--plan"]);
  } finally {
    console.log = previous;
  }
  const plan = JSON.parse(lines[0]);
  assert.equal(plan.kind, "citygo-disposable-web-runtime-stage");
  assert.equal(plan.runtimeStage, true);
  assert.equal(plan.sameWebBootstrap, true);
  assert.equal(plan.syntheticDistinctWebReleases, false);
  assert.equal(plan.realProductApiOrBilling, false);
  await assert.rejects(
    runControllerSmoke(["--runtime-stage", "--disposable"]),
    /Explicit disposable privileged fixture flag required/,
  );
});

test("runtime and switch profiles cannot be combined or take arbitrary overrides", async () => {
  for (const args of [
    ["--runtime-stage", "--durable-v2", "--plan"],
    ["--runtime-stage", "--root=/var/lib/citygo"],
    ["--runtime-stage", "--host=production"],
    ["--runtime-stage", "--apply"],
  ])
    await assert.rejects(runControllerSmoke(args));
});
