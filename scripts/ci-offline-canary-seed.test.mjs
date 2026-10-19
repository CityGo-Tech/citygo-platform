import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderOfflineCanarySeed } from "../deploy/ci/render-offline-canary-seed.mjs";

const operationId = "12345678-1234-4234-8234-123456789abc";
const source = readFileSync(
  new URL("../deploy/ci/offline-clone-canary.py", import.meta.url),
  "utf8",
);
const renderer = readFileSync(
  new URL("../deploy/ci/render-offline-canary-seed.mjs", import.meta.url),
  "utf8",
);
function input(changes = {}) {
  return {
    operationId,
    canarySourceLF: source,
    expectedCanarySha256: createHash("sha256").update(source).digest("hex"),
    ...changes,
  };
}
function denied(value, code) {
  assert.throws(
    () => renderOfflineCanarySeed(value),
    (error) =>
      error instanceof Error &&
      (code
        ? error.message === `offline_canary_seed_${code}`
        : /^offline_canary_seed_[a-z_]+$/.test(error.message)),
  );
}

test("pure renderer has no filesystem, process, network or mutable environment APIs", () => {
  assert.doesNotMatch(
    renderer,
    /node:(?:fs|child_process|https?|net|tls)|process\.|fetch\(|(?:read|write)File|execSync|spawn|\.env/,
  );
});

test("exact public script/argv JSON is valid cloud-config YAML and deterministic", () => {
  const result = renderOfflineCanarySeed(input());
  assert.deepEqual(result, renderOfflineCanarySeed(input()));
  assert.deepEqual(Object.keys(result), [
    "userData",
    "metaData",
    "networkConfig",
  ]);
  assert(result.userData.startsWith("#cloud-config\n"));
  const data = JSON.parse(result.userData.slice("#cloud-config\n".length));
  assert.deepEqual(Object.keys(data), ["write_files", "runcmd"]);
  assert.equal(data.write_files.length, 1);
  assert.deepEqual(data.write_files[0], {
    path: "/usr/local/sbin/citygo-offline-clone-canary.py",
    owner: "root:root",
    permissions: "0700",
    encoding: "b64",
    content: Buffer.from(source, "ascii").toString("base64"),
  });
  assert.equal(
    Buffer.from(data.write_files[0].content, "base64").toString(),
    source,
  );
  assert.deepEqual(data.runcmd, [
    [
      "/usr/bin/python3",
      "-I",
      "-B",
      "/usr/local/sbin/citygo-offline-clone-canary.py",
      "--apply",
      "--operation-id",
      operationId,
      "--acknowledge",
      `RUN_OFFLINE_CANARY:${operationId}`,
    ],
  ]);
  assert(
    !Object.keys(data).some((key) => /users|ssh|password|packages/.test(key)),
  );
  for (const text of Object.values(result))
    assert(!text.includes("\r") && text.endsWith("\n"));
});

test("NoCloud identity is unique and network configuration contains no route/address/DNS/auth", () => {
  const result = renderOfflineCanarySeed(input());
  assert.deepEqual(JSON.parse(result.metaData), {
    "instance-id": `citygo-canary-${operationId}`,
    "local-hostname": `citygo-ci-canary-${operationId}`,
  });
  assert.deepEqual(JSON.parse(result.networkConfig), {
    version: 2,
    ethernets: {
      canary: {
        match: { name: "e*" },
        dhcp4: false,
        dhcp6: false,
        "accept-ra": false,
        "link-local": [],
        optional: true,
      },
    },
  });
  assert.doesNotMatch(
    result.networkConfig,
    /addresses|nameservers|gateway|routes|dhcp4-overrides/,
  );
  assert.notEqual(
    renderOfflineCanarySeed(
      input({ operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    ).metaData,
    result.metaData,
  );
});

test("canonical v4 operation identity is mandatory without YAML/JSON injection", () => {
  for (const value of [
    "",
    operationId.toUpperCase(),
    "00000000-0000-0000-0000-000000000000",
    "12345678-1234-1234-8234-123456789abc",
    "12345678-1234-4234-7234-123456789abc",
    operationId + "\n",
    "../../other",
    '"\\nusers: []',
  ])
    denied(input({ operationId: value }), "operation_invalid");
});

test("whole source hash is mandatory, exact, lowercase and bound to every byte", () => {
  denied(
    input({ expectedCanarySha256: "a".repeat(64) }),
    "source_hash_mismatch",
  );
  denied(input({ expectedCanarySha256: "A".repeat(64) }), "hash_invalid");
  denied(
    input({ canarySourceLF: source + "# changed\n" }),
    "source_hash_mismatch",
  );
  for (const value of [
    "",
    "# not python\n",
    source.replaceAll("\n", "\r\n"),
    source + "\0",
    source + "# кириллица\n",
    source + "\u007f",
    source.slice(0, -1),
    "x".repeat(131073),
  ])
    denied(input({ canarySourceLF: value }), "source_invalid");
});

test("only exact own enumerable data properties are accepted, no getters or prototypes", () => {
  denied(null, "input_invalid");
  denied([], "input_invalid");
  denied(Object.create(input()), "input_invalid");
  denied(input({ extra: "no" }), "input_fields_invalid");
  denied({ operationId, canarySourceLF: source }, "input_fields_invalid");
  denied({ ...input(), [Symbol("extra")]: true }, "input_fields_invalid");
  let called = false;
  const accessor = input();
  Object.defineProperty(accessor, "canarySourceLF", {
    enumerable: true,
    get() {
      called = true;
      return source;
    },
  });
  denied(accessor, "input_field_invalid");
  assert.equal(called, false);
  const hidden = input();
  Object.defineProperty(hidden, "canarySourceLF", {
    value: source,
    enumerable: false,
  });
  denied(hidden, "input_field_invalid");
  denied(input({ canarySourceLF: Buffer.from(source) }), "input_field_invalid");
  assert.deepEqual(
    renderOfflineCanarySeed(Object.assign(Object.create(null), input())),
    renderOfflineCanarySeed(input()),
  );
  denied(
    new Proxy(input(), {
      ownKeys() {
        throw new Error("must-not-run");
      },
    }),
    "input_invalid",
  );
});
