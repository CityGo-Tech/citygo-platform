import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collectImageMetadata } from "./image-content.mjs";
const hash = (raw) =>
  "sha256:" + createHash("sha256").update(raw).digest("hex");
function fixture(indexed = true, change = () => {}) {
  const config = JSON.stringify({ os: "linux", architecture: "amd64" });
  const configId = hash(config);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      digest: configId,
      size: Buffer.byteLength(config),
      mediaType: "application/vnd.oci.image.config.v1+json",
    },
  });
  const manifestId = hash(manifest);
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        digest: manifestId,
        size: Buffer.byteLength(manifest),
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        digest: "sha256:" + "e".repeat(64),
        size: 123,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { os: "unknown", architecture: "unknown" },
      },
    ],
  };
  change(index);
  const root = indexed ? JSON.stringify(index) : manifest,
    rootId = hash(root);
  const blobs = { [configId]: config, [manifestId]: manifest, [rootId]: root },
    calls = [];
  const read = async (kind, digest) => {
    calls.push([kind, digest]);
    assert.ok(digest in blobs);
    return blobs[digest];
  };
  return { rootId, configId, manifestId, blobs, calls, read };
}
test("metadata retains the exact root index and selected manifest/config without layer or attestation reads", async () => {
  for (const indexed of [false, true]) {
    const f = fixture(indexed),
      result = await collectImageMetadata(f.read, f.rootId);
    assert.deepEqual(result.blobs, f.blobs);
    assert.deepEqual(
      f.calls,
      indexed
        ? [
            ["manifests", f.rootId],
            ["manifests", f.manifestId],
            ["blobs", f.configId],
          ]
        : [
            ["manifests", f.manifestId],
            ["blobs", f.configId],
          ],
    );
  }
});
test("ambiguous, absent, nested, externally redirected and incorrectly sized image descriptors reject", async () => {
  for (const change of [
    (v) => v.manifests.push(v.manifests[0]),
    (v) => v.manifests.shift(),
    (v) => (v.manifests[0].platform.architecture = "arm64"),
    (v) => v.manifests[0].size++,
    (v) => (v.manifests[0].size = 262145),
    (v) =>
      (v.manifests[0].mediaType = "application/vnd.oci.image.index.v1+json"),
    (v) => (v.manifests[0].urls = ["https://example.invalid"]),
    (v) => (v.manifests[0].digest = "../untrusted"),
  ]) {
    const f = fixture(true, change);
    await assert.rejects(collectImageMetadata(f.read, f.rootId));
  }
});
test("modified bytes and oversized metadata fail before use; unknown read endpoints are never requested", async () => {
  for (const part of ["rootId", "manifestId", "configId"]) {
    const f = fixture();
    f.blobs[f[part]] += " ";
    await assert.rejects(collectImageMetadata(f.read, f.rootId));
  }
  await assert.rejects(
    collectImageMetadata(
      async () => " ".repeat(262145),
      "sha256:" + "a".repeat(64),
    ),
  );
});
