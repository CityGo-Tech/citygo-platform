import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./env.mjs";
import { renderNginx } from "../deploy/render-pilot.mjs";
import { assertMaintenanceResponse } from "./ingress-maintenance-smoke.mjs";

test("rendered ingress is closed by default, not controlled by client input", () => {
  const config = renderNginx("pilot.example.test");
  const app = config.slice(config.indexOf("    location / {\n"));
  assert.match(
    app,
    /if \(!-f \/var\/lib\/citygo\/ingress\/traffic-open\) \{ return 503; \}/,
  );
  assert.match(app, /open_file_cache off;/);
  assert.match(app, /error_page 503 = @citygo_maintenance;/);
  assert.ok(app.indexOf("return 503;") < app.indexOf("proxy_pass"));
  assert.doesNotMatch(app, /\$http_.*maintenance|\$arg_|\$cookie_/);
  assert.match(app, /proxy_intercept_errors off;/);
  assert.match(app, /proxy_next_upstream off;/);
  assert.match(app, /proxy_buffering off;/);
  assert.equal((config.match(/traffic-open/g) ?? []).length, 1);
  // HTTP-only ACME location stays outside the application's maintenance gate.
  const http = config.slice(0, config.indexOf("    listen 443 ssl"));
  assert.match(http, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.doesNotMatch(http, /traffic-open/);
});

test("maintenance preserves v1 legacy error and uses only server-generated request ID", () => {
  const config = renderNginx("pilot.example.test");
  const location = config.slice(
    config.indexOf("    location @citygo_maintenance"),
  );
  const json = location.match(/return 503 '(.*)';/)[1];
  const protocol = readFileSync(
    join(root, "packages/contracts/src/protocol.ts"),
    "utf8",
  );
  const version = protocol.match(/CONTRACT_VERSION = "(.*?)"/)[1];
  const body = JSON.parse(json);
  assert.equal(body.contractVersion, version);
  assert.equal(body.retryable, false);
  assert.equal(body.code, "SERVICE_UNAVAILABLE");
  assert.equal(typeof body.error, "string");
  assert.equal(body.requestId, "$request_id");
  assert.deepEqual(json.match(/\$\w+/g), ["$request_id"]);
  assert.match(location, /add_header X-CityGo-Contract-Version 1 always;/);
  assert.match(location, /add_header X-Request-Id \$request_id always;/);
  assert.match(location, /add_header Cache-Control no-store always;/);
  assert.doesNotMatch(location, /proxy_pass|Retry-After/);
});

test("ingress allows framing only the empty paid document without bypassing maintenance", () => {
  const config = renderNginx("pilot.example.test");
  assert.match(
    config,
    /map "\$uri:\$status" \$citygo_frame_options \{\s*default DENY;\s*\/paid-pixels\/frame\.html:200 SAMEORIGIN;\s*\}/,
  );
  assert.match(
    config,
    /map \$uri \$citygo_referrer_policy \{\s*default strict-origin-when-cross-origin;\s*\/paid-pixels\/frame\.html no-referrer;\s*\/paid-pixels\/frame\.js no-referrer;\s*\}/,
  );
  const app = config.slice(
    config.indexOf("    location / {\n"),
    config.indexOf("    location @citygo_maintenance"),
  );
  assert.match(app, /proxy_hide_header X-Frame-Options;/);
  assert.match(app, /proxy_hide_header Referrer-Policy;/);
  assert.match(
    config,
    /add_header X-Frame-Options \$citygo_frame_options always;/,
  );
  assert.match(
    config,
    /add_header Referrer-Policy \$citygo_referrer_policy always;/,
  );
  assert.doesNotMatch(config, /location[^\n]*paid-pixels/);
  assert.equal((config.match(/traffic-open/g) ?? []).length, 1);
  const maintenance = config.slice(
    config.indexOf("    location @citygo_maintenance"),
  );
  assert.match(maintenance, /add_header X-Frame-Options DENY always;/);
  assert.match(
    maintenance,
    /add_header Referrer-Policy strict-origin-when-cross-origin always;/,
  );
});

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-citygo-contract-version": "1",
  "x-request-id": "a".repeat(32),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const body = {
  error: "Сервис обновляется",
  code: "SERVICE_UNAVAILABLE",
  contractVersion: "1",
  requestId: "a".repeat(32),
  retryable: false,
};
const response = { status: 503, headers, body: JSON.stringify(body) };
test("smoke assertions accept JSON and bodyless HEAD maintenance", () => {
  assert.doesNotThrow(() => assertMaintenanceResponse(response));
  assert.doesNotThrow(() =>
    assertMaintenanceResponse({ ...response, body: "" }, { head: true }),
  );
});
for (const [name, bad] of Object.entries({
  "successful status": { status: 200 },
  "HTML gateway error": { body: "<html>maintenance</html>" },
  "automatic replay": { body: JSON.stringify({ ...body, retryable: true }) },
  "missing legacy error": {
    body: JSON.stringify({ ...body, error: undefined }),
  },
  "client-controlled request id": {
    body: JSON.stringify({ ...body, requestId: "untrusted" }),
  },
  "cached outage": { headers: { ...headers, "cache-control": "max-age=60" } },
  "missing contract header": {
    headers: { ...headers, "x-citygo-contract-version": undefined },
  },
})) {
  test(`smoke assertions reject ${name}`, () => {
    assert.throws(() => assertMaintenanceResponse({ ...response, ...bad }));
  });
}
