import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const cli = fileURLToPath(new URL("./preview-payments.ts", import.meta.url));
const loader = import.meta.resolve("tsx");
const canary = "SYNTHETIC_NONWORKING_ENV_MUST_NOT_BE_READ";
const secret = "PRIVATE_SYNTHETIC_CONTACT_OR_CREDENTIAL";
const profile = {
  schemaVersion: 1,
  fiscalFramework: "54fz_non_npd",
  approved: true,
  approvalReference: secret,
  cashSolution: "external",
  scenario: "payment_and_receipt",
  businessModel: "wallet_advance",
  itemDescription: "Synthetic advance",
  paymentSubject: "payment",
  paymentMode: "advance",
  vatCode: 1,
  taxSystemCode: 2,
  closingReceipts: {
    strategy: "on_each_service",
    workflowReference: "SYNTHETIC_WORKFLOW",
  },
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "citygo-payment-preview-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, ".env"),
    `YOOKASSA_MODE=live\nYOOKASSA_SECRET_KEY=${canary}\nDATABASE_URL=postgresql://synthetic@127.0.0.1:1/never\n`,
  );
  async function file(name: string, value: unknown) {
    const path = join(directory, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  }
  function run(args: string[] = []) {
    // Do not inherit provider keys, DB URLs, NODE_OPTIONS, .env paths or other
    // session configuration. Nonworking canaries detect accidental activation.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      NODE_ENV: "test",
      YOOKASSA_MODE: "live",
      YOOKASSA_SECRET_KEY: "live_" + canary,
      ROUTERAI_API_KEY: canary,
      DATABASE_URL: "postgresql://synthetic@127.0.0.1:1/never",
    };
    const result = spawnSync(
      process.execPath,
      ["--import", loader, cli, ...args],
      {
        cwd: directory,
        env,
        encoding: "utf8",
        shell: false,
        timeout: 15_000,
        maxBuffer: 32_768,
      },
    );
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(canary));
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
    return result;
  }
  return { directory, file, run };
}

test("payment preview ignores .env/provider configuration and never exits with activation success", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.operatorTaxRegime, "unknown");
  assert.equal(report.activationSupported, false);
  assert.equal(report.readyForLive, false);
  assert.equal(report.credentialsChecked, false);
});

test("strict preparation input accepts the explicit source policy but does not map NPD to 54-FZ", async (t) => {
  const f = await fixture(t);
  const path = await f.file("npd.json", {
    operatorTaxRegime: "npd",
    sourcePolicy: "gift_first_paid_fifo",
    merchantReceiptsReportedEnabled: true,
    fiscalProfile: profile,
  });
  const result = f.run(["--input", path]);
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.operatorTaxRegime, "npd");
  assert.equal(report.fiscalProfileTechnicallyValid, false);
  assert.ok(
    report.blockers.some(
      (gap: { code: string }) => gap.code === "NPD_FISCAL_FLOW_NOT_IMPLEMENTED",
    ),
  );
  assert.equal(
    report.blockers.some(
      (gap: { code: string }) => gap.code === "SOURCE_POLICY_REQUIRED",
    ),
    false,
  );
  assert.equal(
    report.blockers.some(
      (gap: { code: string }) => gap.code === "FISCAL_PROFILE_REQUIRED",
    ),
    false,
  );
});

test("non-NPD preparation is still blocked and old --profile cannot guess the operator regime", async (t) => {
  const f = await fixture(t);
  const input = await f.file("preparation.json", {
    operatorTaxRegime: "non_npd",
    sourcePolicy: "gift_first_paid_fifo",
    merchantReceiptsReportedEnabled: true,
    fiscalProfile: profile,
  });
  const result = f.run(["--input", input]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).fiscalProfileTechnicallyValid, true);
  assert.equal(JSON.parse(result.stdout).blockers.length, 6);
  const legacy = await f.file("profile.json", profile);
  const legacyResult = f.run(["--profile", legacy]);
  assert.equal(legacyResult.status, 2);
  assert.equal(JSON.parse(legacyResult.stdout).operatorTaxRegime, "unknown");
  assert.equal(
    JSON.parse(legacyResult.stdout).fiscalProfileTechnicallyValid,
    false,
  );
});

test("invalid arguments, remote paths and strict-envelope errors are redacted", async (t) => {
  const f = await fixture(t);
  const extra = await f.file("extra.json", {
    operatorTaxRegime: "npd",
    [secret]: secret,
  });
  const invalidRegime = await f.file("regime.json", {
    operatorTaxRegime: "USN",
  });
  for (const args of [
    ["--live"],
    ["--input"],
    ["--input", ""],
    ["--input", extra],
    ["--input", invalidRegime],
    ["--input", "https://PRIVATE.invalid/profile"],
    ["--input", "file:///PRIVATE/profile.json"],
    ["--input", "\\\\PRIVATE.invalid\\profile.json"],
    ["--input", extra, "--activate"],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /исходные данные скрыты/);
    assert.doesNotMatch(result.stderr, /PRIVATE|SyntaxError|ZodError|ENOENT/);
  }
});

test("file input is regular, bounded, UTF-8 and parseable without exposing content", async (t) => {
  const f = await fixture(t);
  const large = join(f.directory, "large.json");
  await writeFile(large, " ".repeat(16_385));
  const malformed = join(f.directory, "malformed.json");
  await writeFile(malformed, "{" + secret);
  const invalidUtf8 = join(f.directory, "invalid-utf8.json");
  await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
  const scalar = await f.file("null.json", null);
  for (const path of [large, malformed, invalidUtf8, scalar, f.directory]) {
    const result = f.run(["--input", path]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /исходные данные скрыты/);
  }
  const boundary = join(f.directory, "boundary.json");
  const value = JSON.stringify({ operatorTaxRegime: "npd" });
  await writeFile(boundary, value + " ".repeat(16_384 - value.length));
  assert.equal(f.run(["--input", boundary]).status, 2);
});
