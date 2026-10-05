import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assessHousingUnicode,
  housingUnicodeBaseline,
  repositoryHousingUnicodeReport,
} from "./housing-unicode-preflight.mjs";

const source = await readFile(
  new URL("../packages/contracts/src/housing-v1.ts", import.meta.url),
  "utf8",
);
const fixtures = JSON.parse(
  await readFile(
    new URL("../packages/db/src/fixtures/housing-v1.json", import.meta.url),
    "utf8",
  ),
);
const assess = (changes = {}) =>
  assessHousingUnicode({
    source,
    fixtures,
    runtime: housingUnicodeBaseline,
    ...changes,
  });

test("reviewed pins and literal snapshots match without granting N3/API approval", () => {
  const before = structuredClone(fixtures);
  const report = assess();
  assert.equal(report.status, "baseline_match");
  assert.equal(report.snapshots, 3);
  assert.equal(report.invalidSnapshots, 0);
  assert.equal(report.unassigned, 0);
  assert.equal(report.surrogates, 0);
  assert.equal(report.nonNfc, 0);
  assert.equal(report.n3Closed, false);
  assert.equal(report.realApiApproved, false);
  assert.deepEqual(fixtures, before);
});

test("Node, ICU or Unicode drift needs review even when positive fixtures pass", () => {
  for (const key of ["node", "icu", "unicode"]) {
    const report = assess({
      runtime: { ...housingUnicodeBaseline, [key]: "future-version" },
    });
    assert.equal(report.status, "review_required");
    assert.equal(report.invalidSnapshots, 0);
    assert.equal(report.runtimeMatches, false);
  }
  assert.equal(assess({ runtime: {} }).status, "review_required");
});

test("source/fixture edits cannot become a new baseline; source CRLF is allowed", () => {
  assert.equal(
    assess({ source: source.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") })
      .sourceMatches,
    true,
  );
  assert.equal(
    assess({ source: source + "\n// changed" }).status,
    "review_required",
  );
  const changed = structuredClone(fixtures);
  changed[2].starterPlan.summary = "Другой корректный синтетический текст";
  const report = assess({ fixtures: changed });
  assert.equal(report.invalidSnapshots, 0);
  assert.equal(report.fixturesMatch, false);
  assert.equal(report.status, "review_required");
});

test("non-NFC content is detected, never normalized or printed", () => {
  const changed = structuredClone(fixtures);
  changed[2].starterPlan.summary = "PRIVATE_CANARY е\u0308";
  const before = structuredClone(changed);
  const report = assess({ fixtures: changed });
  assert.equal(report.nonNfc, 1);
  assert.equal(report.invalidSnapshots, 1);
  assert.equal(report.status, "review_required");
  assert.deepEqual(changed, before);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_CANARY"));
});

test("unassigned scalar/lone surrogate remain explicit risks; supplementary emoji is not a surrogate", () => {
  for (const [value, unassigned, surrogates] of [
    ["PRIVATE_CANARY \u0378", 1, 0],
    ["PRIVATE_CANARY \ud800", 0, 1],
    ["PRIVATE_CANARY 🏠", 0, 0],
  ]) {
    const changed = structuredClone(fixtures);
    changed[2].starterPlan.summary = value;
    const report = assess({ fixtures: changed });
    assert.equal(report.unassigned, unassigned);
    assert.equal(report.surrogates, surrogates);
    assert.equal(report.status, "review_required");
    assert.ok(!JSON.stringify(report).includes("PRIVATE_CANARY"));
  }
});

test("unsupported/malformed snapshots and empty corpus never pass", () => {
  for (const value of [null, {}, [], [{ schemaVersion: 2 }]])
    assert.equal(assess({ fixtures: value }).status, "review_required");
});

test("repository report is reproducible, sanitized and uses the actual process profile", async () => {
  const first = await repositoryHousingUnicodeReport();
  assert.deepEqual(await repositoryHousingUnicodeReport(), first);
  assert.deepEqual(first.actual, {
    node: process.versions.node,
    icu: process.versions.icu,
    unicode: process.versions.unicode,
  });
  assert.equal(first.sourceMatches, true);
  assert.equal(first.fixturesMatch, true);
  assert.equal(
    first.status,
    first.runtimeMatches ? "baseline_match" : "review_required",
  );
});

test("CLI rejects custom files/URLs without echoing arguments", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("./housing-unicode-preflight.mjs", import.meta.url),
      ),
      "https://PRIVATE_CANARY.invalid/dump",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.reason, "preflight_failed");
  assert.equal(report.realApiApproved, false);
  assert.ok(!result.stdout.includes("PRIVATE_CANARY"));
  assert.equal(result.stderr, "");
});
