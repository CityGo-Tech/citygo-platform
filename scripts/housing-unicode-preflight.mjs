import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { r1HousingBriefDraftSchema } from "../packages/contracts/src/housing-v1.ts";

// Offline evidence only. Not an API/readiness gate or approval to use real data.
// These are the existing reviewed pins, not newly generated fixture values.
const sourcePin =
  "09a8c8fb0f7c50ea9e5fbf44fd6b92fe9a720de544f3fd19093ebf106e6ace53";
const fixturesPin =
  "c8228f147f7616b99cb71fac0e34c0bb73ef5dd7df5a0cd253d9aa41eb828744";
export const housingUnicodeBaseline = Object.freeze({
  node: "24.11.1",
  icu: "77.1",
  unicode: "16.0",
});
const digest = (value) => createHash("sha256").update(value).digest("hex");

function stringStatistics(value) {
  const counts = { strings: 0, unassigned: 0, surrogates: 0, nonNfc: 0 };
  function visit(item) {
    if (typeof item === "string") {
      counts.strings++;
      if (item.normalize("NFC") !== item) counts.nonNfc++;
      for (const character of item) {
        if (/\p{Cn}/u.test(character)) counts.unassigned++;
        if (/\p{Cs}/u.test(character)) counts.surrogates++;
      }
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        visit(key);
        visit(child);
      }
    }
  }
  visit(value);
  return counts;
}

export function assessHousingUnicode({ source, fixtures, runtime }) {
  const actual = {
    node: runtime.node,
    icu: runtime.icu,
    unicode: runtime.unicode,
  };
  const runtimeMatches = isDeepStrictEqual(actual, housingUnicodeBaseline);
  const sourceMatches = digest(source.replaceAll("\r\n", "\n")) === sourcePin;
  const fixturesMatch = digest(JSON.stringify(fixtures)) === fixturesPin;
  const count = Array.isArray(fixtures) ? fixtures.length : 0;
  let invalidSnapshots = 0;
  if (Array.isArray(fixtures)) {
    for (const fixture of fixtures) {
      const parsed = r1HousingBriefDraftSchema.safeParse(fixture);
      if (!parsed.success || !isDeepStrictEqual(fixture, parsed.data))
        invalidSnapshots++;
    }
  }
  const counts = stringStatistics(fixtures);
  const baselineMatch =
    runtimeMatches &&
    sourceMatches &&
    fixturesMatch &&
    count === 3 &&
    invalidSnapshots === 0 &&
    counts.unassigned === 0 &&
    counts.surrogates === 0 &&
    counts.nonNfc === 0;
  // No input text, paths, environment, IDs, code points or Zod issues in output.
  return {
    reportVersion: 1,
    scope: "repository_synthetic_fixtures_only",
    status: baselineMatch ? "baseline_match" : "review_required",
    baseline: housingUnicodeBaseline,
    actual,
    runtimeMatches,
    sourceMatches,
    fixturesMatch,
    snapshots: count,
    invalidSnapshots,
    ...counts,
    n3Closed: false,
    realApiApproved: false,
  };
}

export async function repositoryHousingUnicodeReport() {
  // Fixed checked-in paths only: no custom dump, URL, .env or DB input.
  const [source, text] = await Promise.all([
    readFile(
      new URL("../packages/contracts/src/housing-v1.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../packages/db/src/fixtures/housing-v1.json", import.meta.url),
      "utf8",
    ),
  ]);
  return assessHousingUnicode({
    source,
    fixtures: JSON.parse(text),
    runtime: process.versions,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2) throw new Error("Arguments not supported");
    const report = await repositoryHousingUnicodeReport();
    console.log(JSON.stringify(report));
    if (report.status !== "baseline_match") process.exitCode = 1;
  } catch {
    console.log(
      JSON.stringify({
        reportVersion: 1,
        scope: "repository_synthetic_fixtures_only",
        status: "review_required",
        reason: "preflight_failed",
        n3Closed: false,
        realApiApproved: false,
      }),
    );
    process.exitCode = 1;
  }
}
