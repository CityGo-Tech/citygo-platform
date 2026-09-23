// Disposable TLS fixture only. Not an operator tool; never toggles the host marker.
import assert from "node:assert/strict";
import { Agent, request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

export function assertMaintenanceResponse(
  { status, headers, body },
  { head = false } = {},
) {
  assert.equal(status, 503);
  assert.match(headers["content-type"], /^application\/json(?:;|$)/);
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["x-citygo-contract-version"], "1");
  assert.match(headers["x-request-id"], /^[a-f0-9]{32}$/);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  if (head) return assert.equal(body, "");
  const parsed = JSON.parse(body);
  assert.equal(parsed.code, "SERVICE_UNAVAILABLE");
  assert.equal(parsed.contractVersion, "1");
  assert.equal(parsed.requestId, headers["x-request-id"]);
  assert.equal(parsed.retryable, false);
  // Legacy clients read error; they must not get an HTML proxy failure.
  assert.ok(typeof parsed.error === "string" && parsed.error.length > 0);
  assert.equal(parsed.currentVersion, undefined);
}

export async function ingressMaintenanceSmoke({ certificate, trafficFile }) {
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 2,
    maxFreeSockets: 2,
  });
  const ca = readFileSync(certificate);
  function request(path, { method = "GET", onChunk, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: 443,
          servername: "pilot.example.test",
          path,
          method,
          agent,
          ca,
          rejectUnauthorized: true,
          headers: { host: "pilot.example.test", ...headers },
          signal: AbortSignal.timeout(10000),
        },
        (res) => {
          const port = res.socket.localPort;
          let body = "";
          res.setEncoding("utf8");
          res.on("error", reject);
          res.on("data", (chunk) => {
            body += chunk;
            if (body.length > 65536)
              return req.destroy(new Error("Fixture response too large"));
            onChunk?.(body);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body,
              port,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  try {
    let first;
    const started = new Promise((resolve) => {
      first = resolve;
    });
    // This is a fake SSE upstream, NOT a model or the application's chat handler.
    const stream = request("/api/maintenance-stream", {
      onChunk: (chunk) => {
        if (chunk.includes("data: first")) first();
      },
    });
    let streamEnded = false;
    void stream.then(
      () => {
        streamEnded = true;
      },
      () => {
        streamEnded = true;
      },
    );
    // Also observe failures/completion before first chunk; no unhandled promise.
    const earlyEnd = stream.then(() => {
      throw new Error("Fixture stream ended before maintenance");
    });
    try {
      await Promise.race([started, earlyEnd]);
      const admitted = await request("/api/write", { method: "POST" });
      assert.equal(admitted.status, 200);
      assert.equal(JSON.parse(admitted.body).writes, 1);
      assert.equal(
        streamEnded,
        false,
        "Close admission while the fixture SSE is still active",
      );
      unlinkSync(trafficFile); // Only the marker in this harness's mkdtemp directory.
      const denied = await request("/api/write?maintenance=off", {
        method: "POST",
        headers: {
          "x-citygo-maintenance": "off",
          "x-request-id": "untrusted-client-id",
        },
      });
      assertMaintenanceResponse(denied);
      assert.equal(
        denied.port,
        admitted.port,
        "Existing keep-alive connections must obey the new gate",
      );
      for (const [method, path] of [
        ["GET", "/"],
        ["GET", "/api/health"],
        ["OPTIONS", "/api/write"],
        ["HEAD", "/api/ready"],
      ])
        assertMaintenanceResponse(await request(path, { method }), {
          head: method === "HEAD",
        });
      const response = await stream;
      assert.equal(response.status, 200);
      assert.match(response.body, /data: first/);
      assert.match(response.body, /data: last/);
      // Tail is received WHILE admission remains closed, with no Nginx reload.
      assertMaintenanceResponse(await request("/api/stats"));
      writeFileSync(trafficFile, "", { flag: "wx", mode: 0o644 });
      const stats = await request("/api/stats");
      assert.equal(stats.status, 200);
      assert.equal(
        JSON.parse(stats.body).writes,
        1,
        "Rejected writes must never reach upstream",
      );
      const unavailable = await request("/api/upstream-unavailable");
      assert.equal(unavailable.status, 503);
      assert.deepEqual(JSON.parse(unavailable.body), { fixtureUpstream: true });
      console.log(
        "Ingress maintenance passed: closed admission/keep-alive, no upstream write, active SSE completed, explicit reopen, upstream errors preserved",
      );
    } finally {
      // Destroy fixture sockets before waiting if an assertion interrupted the test.
      agent.destroy();
      await Promise.allSettled([stream, earlyEnd]);
    }
  } finally {
    agent.destroy();
  }
}
