import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, open, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ubuntuCloudImage as image,
  ubuntuPublicArtifacts as artifacts,
  parseUbuntuDownloadArgs,
  runUbuntuCloudDownload,
  downloadBoundedPublicArtifact,
} from "../deploy/ci/download-ubuntu-cloud-image.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = Buffer.from(`${image.sha256} *${image.filename}\n`);
const signature = Buffer.from("synthetic detached signature");
function fakeStorage(initial = {}) {
  const files = new Map(
    Object.entries(initial).map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  return {
    files,
    opened: [],
    async read(name, limit) {
      assert(files.has(name));
      const bytes = files.get(name);
      assert(bytes.length <= limit);
      return bytes;
    },
    async openNew(name) {
      assert(!files.has(name), "exclusive create");
      this.opened.push(name);
      files.set(name, Buffer.alloc(0));
      return {
        async write(bytes) {
          files.set(name, Buffer.concat([files.get(name), Buffer.from(bytes)]));
        },
        async close() {},
      };
    },
  };
}
function metadataFetch() {
  const payloads = new Map([
    [artifacts.SHA256SUMS.url, manifest],
    [artifacts["SHA256SUMS.gpg"].url, signature],
  ]);
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert(payloads.has(url), "No image or unapproved URL");
      return new Response(payloads.get(url));
    },
  };
}
function proof() {
  return {
    version: 1,
    kind: "citygo-ubuntu-cloudimage-external-verification",
    serial: image.serial,
    filename: image.filename,
    imageSha256: image.sha256,
    imageBytes: image.bytes,
    manifestSha256: hash(manifest),
    signatureSha256: hash(signature),
    keyringPath: "/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg",
    keyringSha256: "b".repeat(64),
    signerFingerprint: image.signerFingerprint,
    verifiedWith: "gpgv",
    signatureVerifiedExternally: true,
    operatorApprovedDownload: true,
  };
}
const localMetadata = () => ({
  SHA256SUMS: manifest,
  "SHA256SUMS.gpg": signature,
});

test("CLI admits only metadata or explicitly hash-bound image; URLs, paths and keys cannot be supplied", () => {
  assert.deepEqual(parseUbuntuDownloadArgs(["metadata"]), { mode: "metadata" });
  assert.deepEqual(
    parseUbuntuDownloadArgs(["image", "--manifest-sha256", "a".repeat(64)]),
    { mode: "image", manifestSha256: "a".repeat(64) },
  );
  for (const args of [
    [],
    ["image"],
    ["metadata", "--url", "https://bad.test"],
    ["metadata", "--output", "C:/"],
    ["image", "--manifest-sha256", "bad"],
    ["image", "--key", "value"],
  ])
    assert.throws(() => parseUbuntuDownloadArgs(args));
  for (const value of Object.values(artifacts))
    assert.match(
      value.url,
      /^https:\/\/(?:cloud-images|keyserver)\.ubuntu\.com\//,
    );
});
test("metadata uses two fixed public GETs, no auth, key or image, and never manufactures verification", async () => {
  const storage = fakeStorage(),
    network = metadataFetch();
  const result = await runUbuntuCloudDownload(
    { mode: "metadata" },
    { storage, fetchImpl: network.fetch },
  );
  assert.equal(network.calls.length, 2);
  assert.equal(result.signatureVerified, false);
  assert.equal(result.imageDownloaded, false);
  assert.equal(result.readyToBoot, false);
  assert(!storage.files.has("external-verification.json"));
  for (const { options } of network.calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(Object.keys(options.headers), ["Accept"]);
  }
  await assert.rejects(
    runUbuntuCloudDownload(
      { mode: "metadata" },
      { storage, fetchImpl: network.fetch },
    ),
    /OUTPUT_OPEN_FAILED/,
  );
});
test("external exact signature/owner evidence is required before image network I/O", async () => {
  for (const change of [
    null,
    { operatorApprovedDownload: false },
    { signatureVerifiedExternally: false },
    { signerFingerprint: "0".repeat(40) },
    { serial: "20261018" },
    { imageSha256: "a".repeat(64) },
    { signatureSha256: "a".repeat(64) },
    { keyringSha256: "bad" },
    { keyringPath: "/arbitrary/keyring" },
    { verifiedWith: "unverified" },
    { extra: true },
  ]) {
    const storage = fakeStorage({
      ...localMetadata(),
      ...(change === null
        ? {}
        : {
            "external-verification.json": JSON.stringify({
              ...proof(),
              ...change,
            }),
          }),
    });
    let calls = 0;
    await assert.rejects(
      runUbuntuCloudDownload(
        { mode: "image", manifestSha256: hash(manifest) },
        {
          storage,
          fetchImpl: async () => {
            calls++;
            throw Error("unexpected");
          },
        },
      ),
    );
    assert.equal(calls, 0);
    assert.equal(storage.opened.length, 0);
  }
});
test("correct external evidence permits only exact image URL but cannot bypass size/hash checks", async () => {
  const storage = fakeStorage({
    ...localMetadata(),
    "external-verification.json": JSON.stringify(proof()),
  });
  let called = false;
  await assert.rejects(
    runUbuntuCloudDownload(
      { mode: "image", manifestSha256: hash(manifest) },
      {
        storage,
        fetchImpl: async (url) => {
          called = true;
          assert.equal(url, artifacts[image.filename].url);
          return new Response("not an image");
        },
      },
    ),
    /SOURCE_LENGTH_MISMATCH/,
  );
  assert(called);
  assert.equal(storage.files.get(image.filename).toString(), "not an image");
});
test("bounded streamer verifies a small synthetic body and preserves partial data on hash/stream failure", async () => {
  const bytes = Buffer.from("synthetic small body"),
    url = artifacts.SHA256SUMS.url;
  const storage = fakeStorage();
  assert.deepEqual(
    await downloadBoundedPublicArtifact(
      {
        url,
        maxBytes: 100,
        expectedBytes: bytes.length,
        expectedSha256: hash(bytes),
      },
      () => storage.openNew("ok"),
      async () => new Response(bytes),
    ),
    { bytes: bytes.length, sha256: hash(bytes) },
  );
  await assert.rejects(
    downloadBoundedPublicArtifact(
      { url, maxBytes: 100, expectedSha256: "a".repeat(64) },
      () => storage.openNew("bad-hash"),
      async () => new Response(bytes),
    ),
    /SOURCE_HASH_MISMATCH/,
  );
  assert.deepEqual(storage.files.get("bad-hash"), bytes);
  let turn = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (turn++ === 0) controller.enqueue(bytes);
        else controller.error(new Error("synthetic failure"));
      },
    }),
  );
  await assert.rejects(
    downloadBoundedPublicArtifact(
      { url, maxBytes: 100 },
      () => storage.openNew("partial"),
      async () => response,
    ),
  );
  assert.deepEqual(storage.files.get("partial"), bytes);
});
test("redirects, other response URLs, bad HTTP and excessive bodies fail closed", async () => {
  for (const response of [
    new Response("bad", { status: 302 }),
    new Response("bad", { status: 404 }),
    new Response("bad", { headers: { "content-length": "101" } }),
    new Response("x".repeat(101)),
  ]) {
    const storage = fakeStorage();
    await assert.rejects(
      downloadBoundedPublicArtifact(
        { url: artifacts.SHA256SUMS.url, maxBytes: 100 },
        () => storage.openNew("bad"),
        async () => response,
      ),
    );
  }
  const response = new Response("bad");
  Object.defineProperty(response, "url", { value: "https://bad.test/" });
  await assert.rejects(
    downloadBoundedPublicArtifact(
      { url: artifacts.SHA256SUMS.url, maxBytes: 100 },
      () => assert.fail(),
      async () => response,
    ),
    /SOURCE_HTTP_REJECTED/,
  );
  await assert.rejects(
    downloadBoundedPublicArtifact(
      { url: "https://bad.test/", maxBytes: 100 },
      () => assert.fail(),
      async () => assert.fail(),
    ),
    /SOURCE_URL_REJECTED/,
  );
});
test("a wrong or duplicated pinned manifest cannot reach image fetch", async () => {
  for (const content of [
    Buffer.from(`${"a".repeat(64)} *${image.filename}\n`),
    Buffer.concat([manifest, manifest]),
  ]) {
    await assert.rejects(
      runUbuntuCloudDownload(
        { mode: "image", manifestSha256: hash(content) },
        {
          storage: fakeStorage({ ...localMetadata(), SHA256SUMS: content }),
          fetchImpl: async () => assert.fail(),
        },
      ),
      /MANIFEST_TARGET_MISMATCH/,
    );
  }
  await assert.rejects(
    runUbuntuCloudDownload(
      { mode: "image", manifestSha256: "a".repeat(64) },
      {
        storage: fakeStorage(localMetadata()),
        fetchImpl: async () => assert.fail(),
      },
    ),
    /MANIFEST_HASH_MISMATCH/,
  );
});
test("executable has no process/environment/installer bridge and never removes or overwrites artifacts", () => {
  const source = readFileSync(
    new URL("../deploy/ci/download-ubuntu-cloud-image.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /child_process|process\.env|\b(?:spawn|execFile|execSync|unlink|rm|rename|writeFileSync)\s*\(/,
  );
  assert.match(source, /open\(pathFor\(name\), "wx"/);
  assert.match(source, /OUTPUT_REPARSE_REJECTED/);
  assert.equal(image.bytes, 621284352);
  assert.equal(image.serial, "20261017");
});

test("image progress is numeric only, bounded to at most one update per ten seconds", async () => {
  const chunk = new Uint8Array(10 * 1024 * 1024),
    events = [];
  let read = 0,
    tick = -6000,
    written = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (read++ < 3) controller.enqueue(chunk);
        else controller.close();
      },
    }),
  );
  await downloadBoundedPublicArtifact(
    {
      url: artifacts.SHA256SUMS.url,
      maxBytes: chunk.length * 3,
      expectedBytes: chunk.length * 3,
    },
    async () => ({
      async write(bytes) {
        written += bytes.length;
      },
      async close() {},
    }),
    async () => response,
    { onProgress: (event) => events.push(event), clock: () => (tick += 6000) },
  );
  assert.equal(written, chunk.length * 3);
  assert.deepEqual(events, [
    { bytes: 0, total: chunk.length * 3 },
    { bytes: chunk.length * 2, total: chunk.length * 3 },
  ]);
});

test("complete payload followed by a transport EOF error is not successful evidence", async () => {
  const bytes = Buffer.from("synthetic complete public payload");
  let written = Buffer.alloc(0),
    closed = false,
    reads = 0;
  const response = {
    status: 200,
    redirected: false,
    url: artifacts.SHA256SUMS.url,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            if (reads++ === 0) return { done: false, value: bytes };
            throw new Error("synthetic EOF with untrusted diagnostics");
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
  await assert.rejects(
    downloadBoundedPublicArtifact(
      {
        url: artifacts.SHA256SUMS.url,
        maxBytes: bytes.length,
        expectedBytes: bytes.length,
        expectedSha256: hash(bytes),
      },
      async () => ({
        async write(chunk) {
          written = Buffer.concat([written, chunk]);
        },
        async close() {
          closed = true;
        },
      }),
      async () => response,
    ),
    (error) => error.message === "SOURCE_STREAM_FAILED",
  );
  assert.deepEqual(written, bytes);
  assert.equal(hash(written), hash(bytes));
  assert(closed);
});

test("safe phase failures retain primary verification errors instead of masking them during close", async () => {
  const bytes = Buffer.from("synthetic public body"),
    spec = {
      url: artifacts.SHA256SUMS.url,
      maxBytes: bytes.length,
      expectedBytes: bytes.length,
      expectedSha256: hash(bytes),
    };
  for (const [scenario, code] of [
    ["transport", "SOURCE_TRANSPORT_FAILED"],
    ["open", "OUTPUT_OPEN_FAILED"],
    ["write", "OUTPUT_WRITE_FAILED"],
    ["close", "OUTPUT_FINALIZE_FAILED"],
    ["hash-and-close", "SOURCE_HASH_MISMATCH"],
  ]) {
    await assert.rejects(
      downloadBoundedPublicArtifact(
        {
          ...spec,
          expectedSha256:
            scenario === "hash-and-close"
              ? "a".repeat(64)
              : spec.expectedSha256,
        },
        async () => {
          if (scenario === "open") throw new Error("untrusted file path");
          return {
            async write() {
              if (scenario === "write") throw new Error("untrusted write data");
            },
            async close() {
              if (scenario === "close" || scenario === "hash-and-close")
                throw new Error("untrusted sync path");
            },
          };
        },
        async () => {
          if (scenario === "transport") throw new Error("untrusted transport");
          return new Response(bytes);
        },
      ),
      (error) => error.message === code,
      scenario,
    );
  }
});

test("small real exclusive temp file streams, fsyncs, closes and verifies without touching image storage", async () => {
  const directory = await mkdtemp(
      join(tmpdir(), "citygo-ubuntu-download-test-"),
    ),
    target = join(directory, "synthetic-public-artifact.bin"),
    bytes = Buffer.from("synthetic public bytes only\n".repeat(1000));
  let file,
    created = false,
    syncs = 0,
    closes = 0;
  try {
    const result = await downloadBoundedPublicArtifact(
      {
        url: artifacts.SHA256SUMS.url,
        maxBytes: bytes.length,
        expectedBytes: bytes.length,
        expectedSha256: hash(bytes),
      },
      async () => {
        file = await open(target, "wx", 0o600);
        created = true;
        return {
          async write(chunk) {
            await file.writeFile(chunk);
          },
          async close() {
            try {
              await file.sync();
              syncs++;
            } finally {
              await file.close();
              file = undefined;
              closes++;
            }
          },
        };
      },
      async () => new Response(bytes),
    );
    assert.deepEqual(result, { bytes: bytes.length, sha256: hash(bytes) });
    assert.deepEqual(await readFile(target), bytes);
    assert.equal(syncs, 1);
    assert.equal(closes, 1);
  } finally {
    await file?.close();
    if (created) await unlink(target);
    await rmdir(directory);
  }
});
