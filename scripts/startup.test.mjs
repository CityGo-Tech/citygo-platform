import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function start(envOverrides) {
  const env = {
    ...process.env,
    DATABASE_URL: "pglite://:memory:",
    WEB_ORIGIN: "http://localhost:3000",
    TRUSTED_PROXY_CIDRS: "",
    API_PORT: "49999",
    LLM_PROVIDER: "",
    OPENAI_API_KEY: "",
    OPENAI_MODEL: "",
    ROUTERAI_API_KEY: "",
    ROUTERAI_MODEL: "",
    ROUTERAI_UPSTREAM: "",
    ROUTERAI_COUNTRY: "",
    GIGACHAT_CREDENTIALS: "",
    GIGACHAT_MODEL: "",
    GIGACHAT_SCOPE: "",
    GIGACHAT_CA_BUNDLE_FILE: "",
    ...envOverrides,
  };
  if (env.NODE_ENV === undefined) delete env.NODE_ENV;
  return spawnSync(process.execPath, ["apps/api/dist/server.js"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
}

test("built API never silently starts in development mode", () => {
  for (const NODE_ENV of [undefined, "development", "test"]) {
    const result = start({ NODE_ENV });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Production requires PostgreSQL and HTTPS/);
    assert.doesNotMatch(result.stdout, /Server listening/);
  }
});

test("provider configuration errors fail before any database connection", () => {
  for (const LLM_PROVIDER of ["routerai", "gigachat", "openai"]) {
    const result = start({
      DATABASE_URL: "postgresql://127.0.0.1:1/unreachable",
      WEB_ORIGIN: "https://citygo.example",
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
      LLM_PROVIDER,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      LLM_PROVIDER === "openai"
        ? /requires both OPENAI_API_KEY and OPENAI_MODEL/
        : /production activation is blocked/,
    );
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
    assert.doesNotMatch(result.stdout, /Server listening/);
  }
});

test("built API rejects HTTP and missing trusted proxy configuration before connecting", () => {
  const http = start({
    NODE_ENV: undefined,
    DATABASE_URL: "postgresql://localhost/citygo",
  });
  assert.equal(http.status, 1, http.stderr);
  assert.match(http.stderr, /Production requires PostgreSQL and HTTPS/);
  const noProxy = start({
    NODE_ENV: undefined,
    DATABASE_URL: "postgresql://localhost/citygo",
    WEB_ORIGIN: "https://citygo.example",
  });
  assert.equal(noProxy.status, 1, noProxy.stderr);
  assert.match(
    noProxy.stderr,
    /Production requires explicit TRUSTED_PROXY_CIDRS/,
  );
});
