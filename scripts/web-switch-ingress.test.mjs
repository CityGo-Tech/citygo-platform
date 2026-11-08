import assert from "node:assert/strict";
import test from "node:test";
import { renderNginx } from "../deploy/render-pilot.mjs";
import { renderWebSwitchNginx } from "../deploy/render-web-switch.mjs";

test("Web switching remains opt-in and preserves the legacy fixed upstream", () => {
  const legacy = renderNginx("pilot.example.test");
  assert.match(legacy, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.doesNotMatch(legacy, /web-upstream|web-assets|__citygo_web_slot/);
  const config = renderWebSwitchNginx("pilot.example.test");
  assert.equal(
    (
      config.match(
        /include \/var\/lib\/citygo\/ingress\/web-upstream\.conf;/g,
      ) ?? []
    ).length,
    2,
  );
  assert.doesNotMatch(
    config,
    /worker_shutdown_timeout|proxy_next_upstream\s+(?!off;)/,
  );
});

test("all Web-switch routes keep the emergency maintenance marker", () => {
  const config = renderWebSwitchNginx("pilot.example.test");
  assert.equal((config.match(/traffic-open/g) ?? []).length, 3);
  for (const path of [
    "location / {",
    "location ^~ /_next/static/ {",
    "location = /__citygo_web_slot {",
  ]) {
    const location = config.slice(
      config.indexOf(path),
      config.indexOf("\n    }", config.indexOf(path)),
    );
    assert.match(location, /open_file_cache off;/);
    assert.match(
      location,
      /if \(!-f \/var\/lib\/citygo\/ingress\/traffic-open\) \{ return 503; \}/,
    );
    assert.match(location, /error_page 503 = @citygo_maintenance;/);
    assert.doesNotMatch(location, /\$arg_|\$cookie_|\$http_.*upstream/);
  }
});

test("slot proof is local-only, content-free and cannot retry a POST", () => {
  const config = renderWebSwitchNginx("pilot.example.test");
  const probe = config.slice(
    config.indexOf("location = /__citygo_web_slot {"),
    config.indexOf("location @citygo_maintenance"),
  );
  assert.match(probe, /allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/);
  assert.match(probe, /limit_except GET \{ deny all; \}/);
  assert.match(probe, /rewrite \^ \/api\/ready\? break;/);
  assert.match(probe, /proxy_hide_header X-CityGo-Web-Slot;/);
  assert.match(probe, /add_header X-CityGo-Web-Slot \$upstream_addr always;/);
  assert.match(probe, /add_header Cache-Control no-store always;/);
  assert.match(probe, /proxy_next_upstream off;/);
});

test("old immutable chunks are served from the protected archive without proxy fallback", () => {
  const config = renderWebSwitchNginx("pilot.example.test");
  const assets = config.slice(
    config.indexOf("location ^~ /_next/static/ {"),
    config.indexOf("location = /__citygo_web_slot"),
  );
  assert.match(assets, /root \/var\/lib\/citygo\/web-assets;/);
  assert.match(assets, /disable_symlinks on;/);
  assert.match(assets, /autoindex off;/);
  assert.match(assets, /try_files \$uri =404;/);
  assert.match(assets, /expires 1y;/);
  assert.doesNotMatch(assets, /proxy_pass|proxy_next_upstream|add_header/);
});

test("Web-switch renderer rejects directive, wildcard, URL and port injection", () => {
  for (const host of [
    "https://pilot.example.test",
    "pilot.example.test:443",
    "*.example.test",
    "pilot.example.test;return 200;",
    "pilot.example.test\ninclude /tmp/evil;",
  ]) {
    assert.throws(() => renderWebSwitchNginx(host));
  }
});
