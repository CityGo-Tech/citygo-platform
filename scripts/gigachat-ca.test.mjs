import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { root } from "./env.mjs";
import {
  assertGigaChatCa,
  gigaChatCaImagePath,
  gigaChatCaSourcePath,
} from "./gigachat-ca.mjs";

test("bundled GigaChat public CA has the pinned identity and validity period", () => {
  const bytes = readFileSync(join(root, gigaChatCaSourcePath));
  assert.doesNotThrow(() => assertGigaChatCa(bytes));
  const changed = Buffer.from(bytes);
  changed[100] ^= 1;
  for (const value of [
    changed,
    Buffer.concat([bytes, bytes]),
    bytes.toString(),
  ])
    assert.throws(() => assertGigaChatCa(value), /contents hidden/);
  for (const now of [NaN, Date.UTC(2021, 0, 1), Date.UTC(2033, 0, 1)])
    assert.throws(() => assertGigaChatCa(bytes, now), /contents hidden/);
});

test("public CA is copied only into the API image without changing global trust", () => {
  const dockerfile = readFileSync(join(root, "deploy/Dockerfile"), "utf8");
  const api = dockerfile
    .split("FROM runtime AS api")[1]
    ?.split("FROM runtime AS jobs")[0];
  assert.ok(api);
  assert.ok(
    api.includes(
      `COPY --chown=node:node ${gigaChatCaSourcePath} .${gigaChatCaImagePath.slice(4)}`,
    ),
  );
  const other = dockerfile.replace(api, "");
  assert.ok(!other.includes(gigaChatCaSourcePath));
  assert.doesNotMatch(
    dockerfile,
    /NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|update-ca-certificates/,
  );
  const ignore = readFileSync(join(root, ".dockerignore"), "utf8");
  assert.match(ignore, /^\*\*\/\*\.pem$/m);
  assert.match(ignore, /^\*\*\/\*\.key$/m);
});

test("build context accepts only the exact reviewed public certificate", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citygo-public-ca-context-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, gigaChatCaSourcePath);
  mkdirSync(join(directory, "deploy/certificates"), { recursive: true });
  const run = () =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/check-container-context.mjs"), directory],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
  const bytes = readFileSync(join(root, gigaChatCaSourcePath));
  writeFileSync(path, bytes);
  assert.equal(run().status, 0);
  writeFileSync(path, Buffer.concat([bytes, Buffer.from("not-approved")]));
  const changed = run();
  assert.equal(changed.status, 1);
  assert.doesNotMatch(changed.stderr, /not-approved|BEGIN CERTIFICATE/);
  writeFileSync(path, bytes);
  const other = join(directory, "other.crt");
  writeFileSync(other, bytes);
  assert.equal(run().status, 1);
  rmSync(other);
  assert.equal(run().status, 0);
});
