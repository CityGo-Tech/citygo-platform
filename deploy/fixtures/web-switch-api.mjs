// Disposable HTTP fixture only. This is NOT CityGo API, PostgreSQL or billing.
// Its counters test transport preservation; they prove no real monetary rules.
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

const token = "synthetic-web-switch-session";
const attempts = new Map();
const messages = [];
const pending = new Set();
const state = {
  ready: true,
  loggedIn: false,
  dispatches: 0,
  syntheticDebits: 0,
  completed: 0,
  cancelled: 0,
  slowPosts: 0,
  forwarding: [],
};
function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-citygo-contract-version": "1",
  });
  response.end(JSON.stringify(body));
}
function authenticated(request) {
  return (
    state.loggedIn &&
    request.headers.cookie?.split(/;\s*/).includes(`__Host-citygo=${token}`)
  );
}
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://api").pathname;
  const parts = [];
  for await (const part of request) {
    parts.push(part);
    if (parts.reduce((sum, item) => sum + item.length, 0) > 65536)
      return json(response, 413, { error: "fixture-body-limit" });
  }
  let body = {};
  try {
    if (parts.length) body = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    return json(response, 400, { error: "fixture-json" });
  }
  if (path === "/health" || path === "/ready")
    return json(response, state.ready ? 200 : 503, {
      status: state.ready ? "ok" : "not-ready",
    });
  if (path === "/rehearsal/control") {
    if (typeof body.ready === "boolean") state.ready = body.ready;
    if (body.release === true) for (const finish of [...pending]) finish();
    return json(response, 200, { ok: true });
  }
  if (path === "/rehearsal/login") {
    state.loggedIn = true;
    response.setHeader(
      "set-cookie",
      `__Host-citygo=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    return json(response, 200, { userId: "synthetic-user-1" });
  }
  if (path === "/rehearsal/logout") {
    state.loggedIn = false;
    return json(response, 200, { ok: true });
  }
  if (!authenticated(request)) return json(response, 401, { error: "login" });
  if (path === "/rehearsal/probe")
    return json(response, 200, { userId: "synthetic-user-1" });
  if (path === "/rehearsal/stats")
    return json(response, 200, {
      ...state,
      messages,
      attempts: [...attempts.entries()],
    });
  if (path === "/rehearsal/slow-post") {
    state.slowPosts++;
    return json(response, 200, { accepted: state.slowPosts, body });
  }
  if (path !== "/rehearsal/messages")
    return json(response, 404, { error: "fixture-route" });
  if (request.headers.origin !== "https://web-switch.example.test")
    return json(response, 403, { error: "fixture-origin" });
  if (typeof body.requestId !== "string" || attempts.has(body.requestId))
    return json(response, 409, { error: "fixture-request-already-accepted" });
  state.forwarding.push({
    origin: request.headers.origin,
    host: request.headers.host,
    forwardedFor: request.headers["x-forwarded-for"],
    forwardedProto: request.headers["x-forwarded-proto"],
    peer: request.socket.remoteAddress,
  });
  const attempt = { complete: false, syntheticDebits: 0 };
  attempts.set(body.requestId, attempt);
  state.dispatches++;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  let finished = false;
  const finish = () => {
    if (finished || response.destroyed) return;
    finished = true;
    pending.delete(finish);
    // A deliberately silent upstream has emitted no data before this gate.
    response.write(
      'data: {"type":"delta","text":"Synthetic complete answer"}\n\n',
    );
    attempt.complete = true;
    attempt.syntheticDebits++;
    state.syntheticDebits++;
    state.completed++;
    messages.push({
      requestId: body.requestId,
      content: "Synthetic complete answer",
    });
    response.end('data: {"type":"done","messageId":"fixture-message-1"}\n\n');
  };
  pending.add(finish);
  response.on("close", () => {
    pending.delete(finish);
    if (!finished) state.cancelled++;
  });
});
server.listen(4000, "0.0.0.0");
