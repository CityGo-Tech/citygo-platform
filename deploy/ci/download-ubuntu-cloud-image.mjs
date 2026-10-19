// Public artifacts only. No execution, installer, credentials or GPG approval.
// The image action requires a separately written operator/GPG verification file.
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ubuntuCloudImage = Object.freeze({
  serial: "20261017",
  architecture: "amd64",
  filename: "ubuntu-24.04-server-cloudimg-amd64.img",
  sha256: "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94",
  bytes: 621284352,
  signerFingerprint: "D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81",
  outputDirectory: "D:/CityGo-CI/images/noble-20261017",
});
const base = "https://cloud-images.ubuntu.com/releases/noble/release-20261017/";
export const ubuntuPublicArtifacts = Object.freeze({
  SHA256SUMS: { url: base + "SHA256SUMS", maxBytes: 65536 },
  "SHA256SUMS.gpg": { url: base + "SHA256SUMS.gpg", maxBytes: 16384 },
  [ubuntuCloudImage.filename]: {
    url: base + ubuntuCloudImage.filename,
    maxBytes: ubuntuCloudImage.bytes,
    expectedBytes: ubuntuCloudImage.bytes,
    expectedSha256: ubuntuCloudImage.sha256,
  },
});
const allowedUrls = new Set(
  Object.values(ubuntuPublicArtifacts).map((entry) => entry.url),
);
const proofName = "external-verification.json";
const hashPattern = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
class DownloadError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function requireValue(value, code) {
  if (!value) throw new DownloadError(code);
}
function safeFailure(error, fallback) {
  return error instanceof DownloadError ? error : new DownloadError(fallback);
}

export function parseUbuntuDownloadArgs(args) {
  if (args.length === 1 && args[0] === "metadata") return { mode: "metadata" };
  if (
    args.length === 3 &&
    args[0] === "image" &&
    args[1] === "--manifest-sha256" &&
    hashPattern.test(args[2])
  )
    return { mode: "image", manifestSha256: args[2] };
  throw new DownloadError("ARGUMENTS_INVALID");
}

function ordinary(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}
const comparable = (path) => path.replaceAll("\\", "/").toLowerCase();
export async function createUbuntuDownloadStorage() {
  requireValue(process.platform === "win32", "WINDOWS_OUTPUT_REQUIRED");
  const directory = resolve(ubuntuCloudImage.outputDirectory);
  requireValue(
    isAbsolute(directory) &&
      comparable(directory) === comparable(ubuntuCloudImage.outputDirectory),
    "OUTPUT_PATH_INVALID",
  );
  let current = parse(directory).root;
  for (const part of directory
    .slice(current.length)
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = resolve(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== "EEXIST")
        throw new DownloadError("OUTPUT_DIRECTORY_FAILED");
    }
    const stat = await lstat(current);
    requireValue(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "OUTPUT_REPARSE_REJECTED",
    );
    requireValue(
      comparable(await realpath(current)) === comparable(current),
      "OUTPUT_REPARSE_REJECTED",
    );
  }
  const pathFor = (name) => {
    requireValue(
      Object.hasOwn(ubuntuPublicArtifacts, name) || name === proofName,
      "OUTPUT_NAME_INVALID",
    );
    const path = resolve(directory, name);
    requireValue(
      comparable(path).startsWith(comparable(directory) + "/"),
      "OUTPUT_PATH_INVALID",
    );
    return path;
  };
  return {
    async openNew(name) {
      const file = await open(pathFor(name), "wx", 0o600);
      try {
        requireValue(ordinary(await file.stat()), "OUTPUT_FILE_INVALID");
      } catch (error) {
        await file.close();
        throw error;
      }
      return {
        async write(bytes) {
          await file.writeFile(bytes);
        },
        async close() {
          let failure;
          try {
            await file.sync();
          } catch {
            failure = new DownloadError("OUTPUT_SYNC_FAILED");
          }
          try {
            await file.close();
          } catch {
            failure ??= new DownloadError("OUTPUT_CLOSE_FAILED");
          }
          if (failure) throw failure;
        },
      };
    },
    async read(name, maximum) {
      const path = pathFor(name);
      requireValue(ordinary(await lstat(path)), "LOCAL_FILE_INVALID");
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        requireValue(
          ordinary(stat) && stat.size > 0 && stat.size <= maximum,
          "LOCAL_FILE_INVALID",
        );
        const bytes = Buffer.alloc(maximum + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        requireValue(
          bytesRead === stat.size && bytesRead <= maximum,
          "LOCAL_FILE_CHANGED",
        );
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
  };
}

// Streamed and bounded; successful and partial files are never replaced/deleted.
// This helper is separately exportable for small, synthetic verifier tests.
export async function downloadBoundedPublicArtifact(
  spec,
  writer,
  fetchImpl = globalThis.fetch,
  { onProgress, clock = Date.now } = {},
) {
  requireValue(allowedUrls.has(spec.url), "SOURCE_URL_REJECTED");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    spec.expectedBytes ? 20 * 60_000 : 30_000,
  );
  let reader,
    response,
    opened,
    failure,
    result,
    size = 0;
  const digest = createHash("sha256");
  let progressAt = clock(),
    progressBytes = 0;
  try {
    try {
      response = await fetchImpl(spec.url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/octet-stream, text/plain" },
        signal: controller.signal,
      });
    } catch {
      throw new DownloadError("SOURCE_TRANSPORT_FAILED");
    }
    requireValue(
      response.status === 200 &&
        !response.redirected &&
        (!response.url || response.url === spec.url),
      "SOURCE_HTTP_REJECTED",
    );
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      requireValue(/^(0|[1-9][0-9]*)$/.test(declared), "SOURCE_LENGTH_INVALID");
      requireValue(
        Number(declared) > 0 && Number(declared) <= spec.maxBytes,
        "SOURCE_TOO_LARGE",
      );
      if (spec.expectedBytes)
        requireValue(
          Number(declared) === spec.expectedBytes,
          "SOURCE_LENGTH_MISMATCH",
        );
    }
    requireValue(response.body, "SOURCE_BODY_MISSING");
    try {
      opened = await writer();
    } catch (error) {
      throw safeFailure(error, "OUTPUT_OPEN_FAILED");
    }
    if (spec.expectedBytes)
      onProgress?.({ bytes: 0, total: spec.expectedBytes });
    reader = response.body.getReader();
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        // A full payload followed by a broken HTTP EOF remains a failed stream.
        // Never turn an exact-length partial transport into successful evidence.
        throw new DownloadError("SOURCE_STREAM_FAILED");
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      requireValue(size <= spec.maxBytes, "SOURCE_TOO_LARGE");
      digest.update(chunk.value);
      try {
        await opened.write(chunk.value);
      } catch {
        throw new DownloadError("OUTPUT_WRITE_FAILED");
      }
      const now = clock();
      if (
        spec.expectedBytes &&
        onProgress &&
        size - progressBytes >= 10 * 1024 * 1024 &&
        now - progressAt >= 10_000
      ) {
        onProgress({ bytes: size, total: spec.expectedBytes });
        progressAt = now;
        progressBytes = size;
      }
    }
    requireValue(
      size > 0 && (!spec.expectedBytes || size === spec.expectedBytes),
      "SOURCE_LENGTH_MISMATCH",
    );
    const sha256 = digest.digest("hex");
    requireValue(
      !spec.expectedSha256 || sha256 === spec.expectedSha256,
      "SOURCE_HASH_MISMATCH",
    );
    result = { bytes: size, sha256 };
  } catch (error) {
    failure = safeFailure(error, "PUBLIC_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      await reader?.cancel();
    } catch {
      /* Best effort, static errors only. */
    }
    try {
      reader?.releaseLock();
    } catch {
      /* A pending body may already be closed. */
    }
    if (!reader) {
      try {
        await response?.body?.cancel();
      } catch {
        /* No response body leak. */
      }
    }
    try {
      await opened?.close();
    } catch (error) {
      // Cleanup must not hide the primary size/hash/transport error. A failure
      // after successful verification is still an error, never a success.
      failure ??= safeFailure(error, "OUTPUT_FINALIZE_FAILED");
    }
  }
  if (failure) throw failure;
  return result;
}

function manifestChecked(raw) {
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(raw)
    .trim()
    .split(/\r?\n/);
  const matches = lines
    .map((line) => /^([a-f0-9]{64}) [ *](\S+)$/.exec(line))
    .filter((entry) => entry?.[2] === ubuntuCloudImage.filename);
  requireValue(
    matches.length === 1 && matches[0][1] === ubuntuCloudImage.sha256,
    "MANIFEST_TARGET_MISMATCH",
  );
}
export async function runUbuntuCloudDownload(
  options,
  { storage, fetchImpl = globalThis.fetch, onProgress } = {},
) {
  requireValue(
    options?.mode === "metadata" ||
      (options?.mode === "image" && hashPattern.test(options.manifestSha256)),
    "ARGUMENTS_INVALID",
  );
  const io = storage ?? (await createUbuntuDownloadStorage());
  if (options.mode === "metadata") {
    const artifacts = {};
    for (const name of ["SHA256SUMS", "SHA256SUMS.gpg"])
      artifacts[name] = await downloadBoundedPublicArtifact(
        ubuntuPublicArtifacts[name],
        () => io.openNew(name),
        fetchImpl,
      );
    manifestChecked(await io.read("SHA256SUMS", 65536));
    return {
      mode: "metadata",
      serial: ubuntuCloudImage.serial,
      artifacts,
      signatureVerified: false,
      imageDownloaded: false,
      readyToBoot: false,
    };
  }
  const manifest = await io.read("SHA256SUMS", 65536);
  manifestChecked(manifest);
  requireValue(
    hash(manifest) === options.manifestSha256,
    "MANIFEST_HASH_MISMATCH",
  );
  const signature = await io.read("SHA256SUMS.gpg", 16384);
  const proof = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await io.read(proofName, 8192),
    ),
  );
  // An independently produced operator attestation, NOT verification performed
  // by this downloader. Root verifies gpgv with the trusted WSL system keyring.
  requireValue(
    proof &&
      typeof proof === "object" &&
      !Array.isArray(proof) &&
      hashPattern.test(proof.keyringSha256),
    "EXTERNAL_VERIFICATION_REQUIRED",
  );
  const expected = {
    version: 1,
    kind: "citygo-ubuntu-cloudimage-external-verification",
    serial: ubuntuCloudImage.serial,
    filename: ubuntuCloudImage.filename,
    imageSha256: ubuntuCloudImage.sha256,
    imageBytes: ubuntuCloudImage.bytes,
    manifestSha256: options.manifestSha256,
    signatureSha256: hash(signature),
    keyringPath: "/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg",
    keyringSha256: proof.keyringSha256,
    signerFingerprint: ubuntuCloudImage.signerFingerprint,
    verifiedWith: "gpgv",
    signatureVerifiedExternally: true,
    operatorApprovedDownload: true,
  };
  requireValue(
    proof &&
      typeof proof === "object" &&
      !Array.isArray(proof) &&
      Object.keys(proof).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => proof[key] === value),
    "EXTERNAL_VERIFICATION_REQUIRED",
  );
  const artifact = await downloadBoundedPublicArtifact(
    ubuntuPublicArtifacts[ubuntuCloudImage.filename],
    () => io.openNew(ubuntuCloudImage.filename),
    fetchImpl,
    { onProgress },
  );
  return {
    mode: "image",
    serial: ubuntuCloudImage.serial,
    artifact,
    externalVerificationClaimPresent: true,
    artifactHashVerified: true,
    readyToBoot: false,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        await runUbuntuCloudDownload(
          parseUbuntuDownloadArgs(process.argv.slice(2)),
          {
            onProgress: (progress) =>
              process.stderr.write(
                JSON.stringify({
                  event: "public-image-download",
                  ...progress,
                }) + "\n",
              ),
          },
        ),
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof DownloadError
            ? error.code
            : "PUBLIC_DOWNLOAD_FAILED",
        partialFilesPreserved: true,
      }),
    );
    process.exitCode = 1;
  }
}
