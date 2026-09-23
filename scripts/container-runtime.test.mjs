import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { root, serviceEnv } from "./env.mjs";
import { containerSpec } from "./container-runtime.mjs";

const db = "postgresql://synthetic:test@127.0.0.1:1/not-used";
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "citygo-container-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("container runtime ignores local env files and requires injected PostgreSQL for every DB mode", (t) => {
  const directory = fixture(t);
  for (const name of [".env", ".env.api", ".env.worker", ".env.migrator"])
    writeFileSync(
      join(directory, name),
      `DATABASE_URL=${db}\nOPENAI_API_KEY=never-load`,
    );
  for (const mode of ["api", "worker", "migrate"]) {
    for (const DATABASE_URL of [
      undefined,
      "",
      "pglite://:memory:",
      "invalid-secret",
    ])
      assert.throws(
        () => containerSpec(mode, { DATABASE_URL }, directory),
        /injected PostgreSQL/,
      );
    const spec = containerSpec(
      mode,
      { DATABASE_URL: db, NODE_ENV: "development" },
      directory,
    );
    assert.equal(spec.env.NODE_ENV, "production");
    assert.equal(spec.env.OPENAI_API_KEY, undefined);
    assert.equal(spec.env.DATABASE_URL, db);
    assert.ok(!spec.args.some((arg) => /pnpm|build|tsx/.test(arg)));
  }
});

test("standalone routing flag is explicitly scoped and participates in build cache", (t) => {
  const directory = fixture(t);
  const injected = {
    CITYGO_WEB_STANDALONE: "1",
    API_INTERNAL_URL: "http://api:4000",
  };
  for (const scope of ["build", "web"])
    assert.equal(
      serviceEnv(scope, { directory, inherited: injected })
        .CITYGO_WEB_STANDALONE,
      "1",
    );
  for (const scope of ["api", "migrator", "worker", "test", "mobile"])
    assert.equal(
      serviceEnv(scope, { directory, inherited: injected })
        .CITYGO_WEB_STANDALONE,
      undefined,
    );
  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8"));
  assert.ok(
    turbo.tasks["@citygo/web#build"].env.includes("CITYGO_WEB_STANDALONE"),
  );
});

test("container commands and environment are closed allowlists", (t) => {
  const directory = fixture(t);
  const inherited = {
    DATABASE_URL: db,
    OPENAI_API_KEY: "test-secret",
    ADMIN_USER_IDS: "1",
    NODE_OPTIONS: "--require malicious",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    HTTP_PROXY: "http://invalid",
    NEXT_PUBLIC_KEY: "test-secret",
    NODE_ENV: "test",
  };
  for (const mode of ["api", "web", "migrate", "worker"]) {
    const { env } = containerSpec(mode, inherited, directory);
    assert.equal(env.NODE_ENV, "production");
    for (const key of [
      "NODE_OPTIONS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "HTTP_PROXY",
      "NEXT_PUBLIC_KEY",
    ])
      assert.equal(env[key], undefined);
    if (mode !== "api") {
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.ADMIN_USER_IDS, undefined);
    }
    if (mode === "web") {
      assert.equal(env.DATABASE_URL, undefined);
      assert.equal(env.HOSTNAME, "0.0.0.0");
    }
  }
  for (const mode of [
    "constructor",
    "__proto__",
    "sh",
    "migrate;echo secret",
    undefined,
  ])
    assert.throws(
      () => containerSpec(mode, inherited, directory),
      /Unknown container mode/,
    );
});

test("real container launcher runs ready code without pnpm and never passes AI secrets to jobs", (t) => {
  const directory = fixture(t);
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "node_modules/@citygo/db/dist"), {
    recursive: true,
  });
  for (const file of ["env.mjs", "process.mjs", "container-runtime.mjs"])
    copyFileSync(join(root, "scripts", file), join(directory, "scripts", file));
  writeFileSync(
    join(directory, "node_modules/@citygo/db/dist/cli.js"),
    `
    const assert = require('node:assert/strict');
    assert.equal(process.env.NODE_ENV, 'production');
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.DATABASE_URL, ${JSON.stringify(db)});
    console.log('prebuilt migrator reached');
  `,
  );
  const result = spawnSync(
    process.execPath,
    [join(directory, "scripts/container-runtime.mjs"), "migrate"],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      env: {
        ...serviceEnv("test", { directory }),
        DATABASE_URL: db,
        OPENAI_API_KEY: "do-not-leak",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prebuilt migrator reached/);
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-leak/);
});

test("context audit rejects nested secret files and synthetic secret content", (t) => {
  const directory = fixture(t);
  const run = () =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/check-container-context.mjs"), directory],
      {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
        env: serviceEnv("test", { directory }),
      },
    );
  assert.equal(run().status, 0);
  const nested = join(directory, "apps");
  mkdirSync(nested);
  writeFileSync(join(nested, ".env.api"), "OPENAI_API_KEY=do-not-print");
  assert.equal(run().status, 1);
  rmSync(join(nested, ".env.api"));
  writeFileSync(
    join(nested, "source.txt"),
    "citygo-container-context-canary-20260923",
  );
  const result = run();
  assert.equal(result.status, 1);
  assert.doesNotMatch(
    result.stderr,
    /do-not-print|citygo-container-context-canary-20260923/,
  );
});
