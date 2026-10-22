// Bounded registry METADATA only. Never follows descriptor URLs or downloads layers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export const manifestTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
export const indexTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export async function collectImageMetadata(read, rootDigest) {
  const blobs = {};
  const fetchJson = async (kind, digest, size) => {
    assert.match(digest, digestPattern);
    const raw = await read(kind, digest);
    assert.equal(typeof raw, "string");
    const length = Buffer.byteLength(raw);
    assert.ok(length > 0 && length <= 262144);
    if (size !== undefined) assert.equal(length, size);
    assert.equal(
      "sha256:" + createHash("sha256").update(raw).digest("hex"),
      digest,
    );
    const value = JSON.parse(raw);
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    blobs[digest] = raw;
    return value;
  };
  const link = (value) => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    assert.match(value.digest, digestPattern);
    assert.ok(
      Number.isSafeInteger(value.size) &&
        value.size > 0 &&
        value.size <= 262144,
    );
    assert.equal("urls" in value || "data" in value, false);
    return value;
  };
  let manifest = await fetchJson("manifests", rootDigest);
  if (indexTypes.has(manifest.mediaType)) {
    assert.equal(manifest.schemaVersion, 2);
    assert.ok(
      Array.isArray(manifest.manifests) &&
        manifest.manifests.length > 0 &&
        manifest.manifests.length <= 32,
    );
    const selected = manifest.manifests.filter(
      (v) =>
        v?.platform?.os === "linux" && v?.platform?.architecture === "amd64",
    );
    assert.equal(selected.length, 1, "One Linux/amd64 descriptor required");
    const child = link(selected[0]);
    assert.ok(manifestTypes.has(child.mediaType));
    manifest = await fetchJson("manifests", child.digest, child.size);
    assert.equal(manifest.mediaType, child.mediaType);
  }
  assert.ok(manifestTypes.has(manifest.mediaType));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal("artifactType" in manifest || "subject" in manifest, false);
  const config = link(manifest.config);
  assert.ok(
    [
      "application/vnd.oci.image.config.v1+json",
      "application/vnd.docker.container.image.v1+json",
    ].includes(config.mediaType),
  );
  await fetchJson("blobs", config.digest, config.size);
  // Python's independent image gate validates all index descriptors, exact
  // expected IDs, RootFS and labels against these same content-addressed bytes.
  return { blobs };
}
