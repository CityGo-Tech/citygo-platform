import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import { getCACertificates } from "node:tls";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGigaPost, gigaAuthUrl, gigaChatUrl } from "./gigachat-http.js";

const init = {
  headers: { Authorization: "Basic test-key" },
  body: "scope=test",
  signal: new AbortController().signal,
};

test("GigaChat HTTPS transport verifies TLS, isolates CA trust and never follows redirects", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citygo-giga-ca-test-"));
  const path = join(directory, "ca.pem");
  const root = getCACertificates("bundled")[0]!;
  writeFileSync(path, root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let status = 200,
    calls = 0;
  const originalRoots = getCACertificates("default");
  t.mock.method(
    https,
    "request",
    (
      url: string,
      options: https.RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      calls++;
      assert.equal(url, gigaAuthUrl);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assert.equal(options.method, "POST");
      assert.equal(options.signal, init.signal);
      assert.equal((options.ca as string[]).at(-1), root);
      const responseBody = new PassThrough();
      const incoming = responseBody as unknown as IncomingMessage;
      incoming.statusCode = status;
      incoming.rawHeaders = ["content-type", "application/json"];
      const request = new PassThrough();
      request.end = ((body: string) => {
        assert.equal(body, init.body);
        callback(incoming);
        if (status === 200) responseBody.end('{"ok":true}');
        return request;
      }) as typeof request.end;
      return request as unknown as ClientRequest;
    },
  );
  const post = createGigaPost(path);
  assert.deepEqual(await (await post(gigaAuthUrl, init)).json(), { ok: true });
  status = 302;
  assert.equal((await post(gigaAuthUrl, init)).status, 302);
  assert.equal(calls, 2);
  assert.deepEqual(getCACertificates("default"), originalRoots);
  await assert.rejects(
    post("https://other.example/redirect", init),
    /Unexpected GigaChat endpoint/,
  );
  assert.equal(calls, 2);
});

test("GigaChat rejects invalid CA files before making network requests", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "citygo-giga-invalid-ca-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "invalid.pem");
  for (const contents of [
    "",
    "not a certificate",
    "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
    "x".repeat(256 * 1024 + 1),
  ]) {
    writeFileSync(path, contents);
    assert.throws(() => createGigaPost(path), {
      message:
        "GIGACHAT_CA_BUNDLE_FILE must be a readable PEM CA certificate bundle",
    });
  }
  assert.throws(
    () => createGigaPost(join(directory, "missing.pem")),
    /GIGACHAT_CA_BUNDLE_FILE/,
  );
  assert.throws(() => createGigaPost(directory), /GIGACHAT_CA_BUNDLE_FILE/);
});

test("GigaChat HTTPS pre-abort does not start a connection and transport errors are sanitized", async (t) => {
  let calls = 0;
  t.mock.method(https, "request", () => {
    calls++;
    const request = new PassThrough();
    request.end = (() => {
      queueMicrotask(() =>
        request.emit("error", new Error("private TLS details")),
      );
      return request;
    }) as typeof request.end;
    return request as unknown as ClientRequest;
  });
  const post = createGigaPost();
  await assert.rejects(
    post(gigaChatUrl, { ...init, signal: AbortSignal.abort() }),
  );
  assert.equal(calls, 0);
  await assert.rejects(post(gigaChatUrl, init), {
    message: "GigaChat HTTPS request failed",
  });
  assert.equal(calls, 1);
});
