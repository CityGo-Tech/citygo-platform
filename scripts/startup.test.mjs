import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { serviceEnv } from "./env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("built policy preview is packaged and uses only public fields, without DB/provider startup", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../deploy/fixtures/routerai-profile.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const run = (overrides = {}) =>
    spawnSync(process.execPath, ["apps/api/dist/preview-policy.js"], {
      cwd: root,
      env: {
        ...serviceEnv("test"),
        ...fixture,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://127.0.0.1:1/unreachable",
        OPENAI_API_KEY: "synthetic-ignored-key",
        ...overrides,
      },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const policy = JSON.parse(result.stdout);
  assert.match(policy.id, /^[a-f0-9]{64}$/);
  assert.equal(policy.model, fixture.ROUTERAI_MODEL);
  assert.ok(policy.data.includes(fixture.ROUTERAI_DATA_NOTICE));
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout,
    /synthetic-not-live|synthetic-ignored-key|postgresql|Server listening/,
  );
  const missing = run({ ROUTERAI_DATA_NOTICE: "" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.doesNotMatch(
    missing.stderr,
    /synthetic-not-live|synthetic-ignored-key|postgresql|ECONNREFUSED/,
  );
});

test("built private assistant-mode factory is independently importable and configures three synthetic adapters without I/O", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../deploy/fixtures/routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-gigachat-flat3-profile.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // A host path to the same public CA is required by this local built-artifact
  // test. The production mounted profile separately fixes the /app/certs path.
  fixture.GIGACHAT_CA_BUNDLE_FILE = fileURLToPath(
    new URL("../deploy/certificates/russian-trusted-root.crt", import.meta.url),
  );
  const script = `
    import assert from 'node:assert/strict';
    import https from 'node:https';
    import http from 'node:http';
    import net from 'node:net';
    let calls=0;
    const noIo=()=>{calls++;assert.fail('Static factory import must not perform network or server I/O');};
    globalThis.fetch=noIo;
    https.request=noIo;http.request=noIo;
    net.connect=noIo;net.createConnection=noIo;net.Server.prototype.listen=noIo;
    const {readConfig}=await import('@citygo/config');
    const {createAssistantModes}=await import('./dist/ai-modes.js');
    assert.equal(typeof createAssistantModes,'function');
    const config=readConfig({...${JSON.stringify(fixture)},NODE_ENV:'production',LLM_PROVIDER:'routerai',
      WEB_ORIGIN:'https://citygo.example',TRUSTED_PROXY_CIDRS:'127.0.0.1/32',
      AI_MODES_PRODUCTION_POLICY_ID:'0'.repeat(64)});
    const pending=createAssistantModes(config);
    assert.equal(pending.productionApproved,false);
    assert.ok(pending.modeCatalog().options.every(({available})=>available===false));
    const modes=createAssistantModes({...config,AI_MODES_PRODUCTION_POLICY_ID:pending.policy.id});
    assert.equal(modes.productionApproved,true);
    assert.deepEqual(modes.routes.map(({id,provider})=>[id,provider.name,provider.model]),[
      ['maximum','routerai','openai/gpt-6.1-sol'],
      ['balanced','routerai','deepseek/deepseek-v4-pro-0813'],
      ['minimum','gigachat','GigaChat-3-Ultra']]);
    assert.deepEqual(modes.modeCatalog().options.map(({id,available})=>[id,available]),[
      ['maximum',true],['balanced',true],['minimum',true]]);
    assert.deepEqual(modes.modeCatalog().options[2].price,{kind:'fixed',currency:'RUB',amountMicros:3000000});
    assert.equal(modes.routes[2].fixedFee.scope,'GIGACHAT_API_PERS');
    assert.equal(modes.routes[2].fixedFee.leaseMs,90000);
    assert.equal(modes.ready({provider:'disabled',policyId:null,revision:1}),false);
    assert.throws(()=>modes.resolve({provider:'disabled',policyId:null,revision:1},{}));
    assert.equal(calls,0);
    console.log('built-assistant-mode-factory-static-only');`;
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|TMPDIR)$/i.test(
        key,
      ),
    ),
  );
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("../apps/api/", import.meta.url)),
      env: serviceEnv("test", { inherited, loadFiles: false }),
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    "built-assistant-mode-factory-static-only",
  );
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /synthetic|postgresql|Server listening|ECONNREFUSED/,
  );
});

function start(envOverrides) {
  const env = {
    ...serviceEnv("test"),
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
    ROUTERAI_REASONING_EFFORT: "",
    ROUTERAI_MAX_OUTPUT_TOKENS: "",
    ROUTERAI_REQUEST_TIMEOUT_MS: "",
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

test("built worker rejects PGlite and has no API/AI startup dependency", () => {
  const worker = (DATABASE_URL) =>
    spawnSync(process.execPath, ["apps/worker/dist/index.js", "--once"], {
      cwd: root,
      env: { ...serviceEnv("test"), NODE_ENV: "production", DATABASE_URL },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
  const local = worker("pglite://:memory:");
  assert.equal(local.status, 1, local.stderr);
  assert.match(local.stderr, /Worker requires server PostgreSQL/);
  const offline = worker(
    "postgresql://synthetic:synthetic@127.0.0.1:1/not_used?connect_timeout=1",
  );
  assert.equal(offline.status, 1, offline.stderr);
  assert.equal(
    offline.stderr.trim(),
    "CityGo worker failed; maintenance completion is not confirmed",
  );
  assert.doesNotMatch(offline.stdout, /maintenance completed/);
  assert.doesNotMatch(offline.stderr, /ECONNREFUSED|postgresql|synthetic/);
  assert.doesNotMatch(
    offline.stderr,
    /WEB_ORIGIN|TRUSTED_PROXY|OPENAI|LLM|production activation/,
  );
});
