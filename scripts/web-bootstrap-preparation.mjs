// Builds an OFFLINE review kit. There is deliberately no install/apply command.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { renderWebSwitchNginx } from "../deploy/render-web-switch.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PAYLOAD = [
  ["deploy/backup/backup.py", "controller/backup.py"],
  ["deploy/backup/web_switch.py", "controller/web_switch.py"],
  ["deploy/backup/web_switch_assets.py", "controller/web_switch_assets.py"],
  [
    "docs/runbooks/web-switch-bootstrap.md",
    "docs/runbooks/web-switch-bootstrap.md",
  ],
  ["docs/runbooks/staged-web-switch.md", "docs/runbooks/staged-web-switch.md"],
  [
    "docs/operations/web-switch-rehearsal-2026-11-09.md",
    "docs/operations/web-switch-rehearsal-2026-11-09.md",
  ],
  [
    "docs/operations/web-bootstrap-preparation-2026-11-09.md",
    "docs/operations/web-bootstrap-preparation-2026-11-09.md",
  ],
];
const GATES = [
  "exact-owner-approval-for-bootstrap-not-just-merge",
  "fresh-complete-inventory-and-runtime-compatibility",
  "fresh-encrypted-backup-and-isolated-restore",
  "disk-space-for-backup-assets-and-rollback",
  "single-api-recreation-under-closed-drained-ingress",
  "canonical-files-and-original-restart-policies-preserved",
  "real-image-static-and-public-manifests-including-characters",
  "external-nginx-reloads-excluded-until-pending-settled",
  "root-owned-installation-and-nginx-symlink-reconciliation",
  "fresh-post-bootstrap-v2-plan-pins-and-tls-probes",
  "return-to-canonical-runtime-with-fresh-evidence",
];
const hash = (raw) => createHash("sha256").update(raw).digest("hex");

export function buildReviewManifest(host, payload) {
  // The existing renderer performs hostname validation. No URLs, ports or paths.
  renderWebSwitchNginx(host);
  const expected = [...PAYLOAD.map(([, target]) => target), "nginx/pilot.conf"];
  assert.deepEqual(Object.keys(payload).sort(), expected.sort());
  const files = {};
  for (const name of expected) {
    const raw = payload[name];
    assert.ok(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 1048576);
    files[name] = { sha256: hash(raw), size: raw.length };
  }
  return {
    version: 1,
    purpose: "citygo-web-bootstrap-offline-review-v1",
    host,
    readyToApply: false,
    productionPlan: false,
    deploymentAuthorization: false,
    controllerPlan: { version: 2, purpose: "citygo-staged-web-switch-v2" },
    firstCanary: "same-approved-live-web-image-and-source",
    proposedRuntimeDeltas: {
      api: {
        trustedProxyCidrs: ["172.30.92.10/32", "172.30.92.20/32"],
        restartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
        singleton: true,
      },
      oldWeb: { port: 3000, ip: "172.30.92.10", restartPolicy: "no" },
      newWeb: {
        port: 3001,
        ip: "172.30.92.20",
        restartPolicy: "unless-stopped",
      },
    },
    unchanged: [
      "application-images-and-source",
      "api-env-except-trusted-proxy-cidrs",
      "runtime-profile-and-secrets",
      "postgres-and-schema",
      "business-tariffs-and-postpay",
      "receipts-phone-and-gift",
      "operator-budgets-and-counters",
      "legacy-config-compose-and-receipts",
      "advertising-and-autodeploy",
    ],
    pendingEvidence: GATES,
    files,
  };
}

function readPayload(host) {
  const payload = {};
  for (const [source, target] of PAYLOAD) {
    const path = join(ROOT, source);
    const before = lstatSync(path);
    assert.ok(
      before.isFile() && !before.isSymbolicLink() && before.size <= 1048576,
    );
    const raw = readFileSync(path);
    const after = lstatSync(path);
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"])
      assert.equal(
        before[key],
        after[key],
        "Source changed while preparing kit",
      );
    payload[target] = raw;
  }
  payload["nginx/pilot.conf"] = Buffer.from(renderWebSwitchNginx(host));
  return payload;
}

export function prepareKit(host) {
  const payload = readPayload(host);
  const manifest = buildReviewManifest(host, payload);
  // All output stays in the repository's ignored .local directory. Refuse links
  // and existing operation directories; never overwrite another kit.
  let parent = ROOT;
  for (const part of [".local", "web-bootstrap-preparation"]) {
    parent = join(parent, part);
    try {
      mkdirSync(parent);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const meta = lstatSync(parent);
    assert.ok(meta.isDirectory() && !meta.isSymbolicLink());
  }
  const output = join(parent, randomUUID());
  mkdirSync(output);
  for (const [name, raw] of Object.entries(payload)) {
    const path = join(output, name);
    if (dirname(path) !== output) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, raw, { flag: "wx" });
  }
  writeFileSync(
    join(output, "review.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    {
      flag: "wx",
    },
  );
  return { output, manifest };
}

export function runPreparation(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan")) {
    return {
      purpose: "citygo-web-bootstrap-offline-review-v1",
      readyToApply: false,
      writes: false,
      serverAccess: false,
      execution: "--prepare --host=<hostname> (local files only)",
      applyCommand: null,
    };
  }
  assert.equal(args.length, 2, "Only --prepare --host=<hostname> is supported");
  assert.equal(args[0], "--prepare");
  assert.ok(args[1].startsWith("--host="));
  const { output, manifest } = prepareKit(args[1].slice(7));
  return { output, readyToApply: manifest.readyToApply, files: manifest.files };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(JSON.stringify(runPreparation(process.argv.slice(2)), null, 2));
}
