import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildReviewManifest,
  runPreparation,
} from "./web-bootstrap-preparation.mjs";

const fixture = () =>
  Object.fromEntries(
    [
      "controller/backup.py",
      "controller/web_switch.py",
      "controller/web_switch_assets.py",
      "docs/runbooks/web-switch-bootstrap.md",
      "docs/runbooks/staged-web-switch.md",
      "docs/operations/web-switch-rehearsal-2026-11-09.md",
      "docs/operations/web-bootstrap-preparation-2026-11-09.md",
      "nginx/pilot.conf",
    ].map((name) => [name, Buffer.from(`synthetic ${name}`)]),
  );

test("review kit stays distinct from controller authorization and records every pending gate", () => {
  const files = fixture();
  const manifest = buildReviewManifest("pilot.example.test", files);
  assert.equal(manifest.readyToApply, false);
  assert.equal(manifest.productionPlan, false);
  assert.equal(manifest.deploymentAuthorization, false);
  assert.notEqual(manifest.purpose, manifest.controllerPlan.purpose);
  assert.equal(manifest.controllerPlan.version, 2);
  assert.equal(manifest.pendingEvidence.length, 11);
  assert.ok(
    manifest.pendingEvidence.includes(
      "external-nginx-reloads-excluded-until-pending-settled",
    ),
  );
  for (const [name, raw] of Object.entries(files)) {
    assert.deepEqual(manifest.files[name], {
      sha256: createHash("sha256").update(raw).digest("hex"),
      size: raw.length,
    });
  }
});

test("preparation pins the only intended runtime deltas and same-image canary", () => {
  const manifest = buildReviewManifest("pilot.example.test", fixture());
  assert.equal(manifest.firstCanary, "same-approved-live-web-image-and-source");
  assert.deepEqual(manifest.proposedRuntimeDeltas.api, {
    trustedProxyCidrs: ["172.30.92.10/32", "172.30.92.20/32"],
    restartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    singleton: true,
  });
  assert.equal(manifest.proposedRuntimeDeltas.oldWeb.restartPolicy, "no");
  assert.equal(
    manifest.proposedRuntimeDeltas.newWeb.restartPolicy,
    "unless-stopped",
  );
  assert.ok(manifest.unchanged.includes("business-tariffs-and-postpay"));
  assert.ok(manifest.unchanged.includes("advertising-and-autodeploy"));
});

test("inert invocation and unsupported apply/override arguments cannot prepare or deploy", () => {
  assert.equal(runPreparation([]).writes, false);
  assert.equal(runPreparation(["--plan"]).applyCommand, null);
  for (const args of [
    ["--apply"],
    ["--prepare", "--host=pilot.example.test", "--force"],
    ["--prepare", "--host=https://pilot.example.test/path"],
  ]) {
    assert.throws(() => runPreparation(args));
  }
});

test("unexpected payload, empty/oversized bytes and hostile hostnames are rejected", () => {
  for (const host of [
    "../../etc",
    "pilot.test\nserver{}",
    "user@pilot.test",
    "pilot.test:443",
  ]) {
    assert.throws(() => buildReviewManifest(host, fixture()));
  }
  const extra = { ...fixture(), "controller/secret.json": Buffer.from("x") };
  assert.throws(() => buildReviewManifest("pilot.example.test", extra));
  for (const raw of [Buffer.alloc(0), Buffer.alloc(1048577), "not bytes"]) {
    assert.throws(() =>
      buildReviewManifest("pilot.example.test", {
        ...fixture(),
        "docs/runbooks/web-switch-bootstrap.md": raw,
      }),
    );
  }
});
