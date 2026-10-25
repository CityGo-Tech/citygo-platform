import assert from "node:assert/strict";
import test from "node:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { apiKeys, root, serviceEnv } from "./env.mjs";
import { commandArgs, launch } from "./process.mjs";

// All credentials below are non-working test canaries. Never load real .env.
const canaries = {
  DATABASE_URL: "postgresql://synthetic:canary@127.0.0.1:1/not-used",
  TEST_DATABASE_URL: "postgresql://synthetic:test-canary@127.0.0.1:1/not-used",
  OPENAI_API_KEY: "synthetic-openai",
  ROUTERAI_API_KEY: "synthetic-routerai",
  ROUTERAI_DATA_NOTICE: "Synthetic public operator notice",
  ROUTERAI_PRODUCTION_POLICY_ID: "a".repeat(64),
  AI_CREDIT_MODE: "routerai_at_cost",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  AI_ASSISTANT_MODES: "enabled",
  AI_MAXIMUM_REASONING_EFFORT: "medium",
  AI_MODES_DATA_NOTICE: "Synthetic assistant modes public notice",
  AI_MODES_PRODUCTION_POLICY_ID: "b".repeat(64),
  YOOKASSA_MODE: "test",
  YOOKASSA_SHOP_ID: "12345",
  YOOKASSA_SECRET_KEY: "test_synthetic_canary",
  R1_HOUSING_API_MODE: "synthetic",
  GIGACHAT_CREDENTIALS: "synthetic-gigachat",
  GIGACHAT_ACCESS_TOKEN: "synthetic-token",
  FUTURE_PROVIDER_KEY: "synthetic-future",
  AWS_SECRET_ACCESS_KEY: "synthetic-cloud",
  NEXT_PUBLIC_SECRET: "synthetic-public",
  EXPO_PUBLIC_SECRET: "synthetic-expo",
  NODE_OPTIONS: "--require /never-load-this",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  HTTP_PROXY: "http://user:secret@invalid",
  npm_config_token: "synthetic-npm",
  LLM_PROVIDER: "openai",
  OPENAI_MODEL: "test/model",
  ADMIN_USER_IDS: "synthetic-admin",
  EMAIL_REGISTRATION_MODE: "required",
  EMAIL_REGISTRATION_SECRET: "a".repeat(64),
  EMAIL_DELIVERY_PROVIDER: "yandex_postbox",
  POSTBOX_ACCESS_KEY_ID: "synthetic-postbox-access",
  POSTBOX_SECRET_ACCESS_KEY: "synthetic-postbox-secret",
  POSTBOX_FROM_EMAIL: "synthetic-sender@example.test",
  EMAIL_SEND_DAILY_LIMIT: "10",
  EMAIL_SEND_TOTAL_LIMIT: "20",
  PHONE_VERIFICATION_MODE: "sms_ru",
  PHONE_VERIFICATION_SECRET: "b".repeat(64),
  SMS_RU_MODE: "live",
  SMS_RU_API_ID: "synthetic-sms-api-id",
  SMS_RU_FROM: "CityGo",
  PROSTOSMS_MODE: "live",
  PROSTOSMS_API_KEY: "synthetic-prostosms-key",
  PROSTOSMS_SENDER: "CityGo",
  PHONE_SMS_GLOBAL_DAILY_LIMIT: "10",
  PHONE_SMS_GLOBAL_TOTAL_LIMIT: "20",
};
function fixture(t, files = {}) {
  const directory = mkdtempSync(join(tmpdir(), "citygo-env-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    const target = join(directory, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  return directory;
}
const serialized = Object.entries(canaries)
  .map(([k, v]) => `${k}=${v}`)
  .join("\n");

test("build/Web/mobile/test environments reject all inherited runtime credentials", (t) => {
  const directory = fixture(t, { ".env": serialized });
  for (const scope of ["build", "web", "web-test", "mobile", "test"]) {
    const env = serviceEnv(scope, { directory, inherited: canaries });
    for (const key of Object.keys(canaries)) {
      if (scope === "test" && key === "TEST_DATABASE_URL") continue;
      assert.equal(env[key], undefined, `${scope} must omit ${key}`);
    }
  }
});

test("API gets only known API settings; worker/migrator get no LLM or API settings", (t) => {
  const directory = fixture(t, { ".env": serialized });
  const api = serviceEnv("api", { directory, inherited: {} });
  assert.equal(api.OPENAI_API_KEY, canaries.OPENAI_API_KEY);
  assert.equal(api.ROUTERAI_API_KEY, canaries.ROUTERAI_API_KEY);
  assert.equal(api.ROUTERAI_DATA_NOTICE, canaries.ROUTERAI_DATA_NOTICE);
  assert.equal(api.AI_CREDIT_MODE, canaries.AI_CREDIT_MODE);
  for (const key of [
    "AI_ASSISTANT_MODES",
    "AI_MAXIMUM_REASONING_EFFORT",
    "AI_MODES_DATA_NOTICE",
    "AI_MODES_PRODUCTION_POLICY_ID",
  ])
    assert.equal(api[key], canaries[key]);
  assert.equal(
    api.AI_CREDIT_RESERVATION_MODE,
    canaries.AI_CREDIT_RESERVATION_MODE,
  );
  assert.equal(api.YOOKASSA_MODE, canaries.YOOKASSA_MODE);
  assert.equal(api.YOOKASSA_SHOP_ID, canaries.YOOKASSA_SHOP_ID);
  assert.equal(api.YOOKASSA_SECRET_KEY, canaries.YOOKASSA_SECRET_KEY);
  assert.equal(api.R1_HOUSING_API_MODE, "synthetic");
  assert.equal(api.EMAIL_REGISTRATION_MODE, "required");
  assert.equal(
    api.EMAIL_REGISTRATION_SECRET,
    canaries.EMAIL_REGISTRATION_SECRET,
  );
  assert.equal(
    api.ROUTERAI_PRODUCTION_POLICY_ID,
    canaries.ROUTERAI_PRODUCTION_POLICY_ID,
  );
  assert.equal(api.GIGACHAT_CREDENTIALS, canaries.GIGACHAT_CREDENTIALS);
  assert.equal(api.FUTURE_PROVIDER_KEY, undefined);
  for (const key of [
    "EMAIL_DELIVERY_PROVIDER",
    "POSTBOX_ACCESS_KEY_ID",
    "POSTBOX_SECRET_ACCESS_KEY",
    "POSTBOX_FROM_EMAIL",
    "EMAIL_SEND_DAILY_LIMIT",
    "EMAIL_SEND_TOTAL_LIMIT",
    "PHONE_VERIFICATION_MODE",
    "PHONE_VERIFICATION_SECRET",
    "SMS_RU_MODE",
    "SMS_RU_API_ID",
    "SMS_RU_FROM",
    "PROSTOSMS_MODE",
    "PROSTOSMS_API_KEY",
    "PROSTOSMS_SENDER",
    "PHONE_SMS_GLOBAL_DAILY_LIMIT",
    "PHONE_SMS_GLOBAL_TOTAL_LIMIT",
  ])
    assert.equal(api[key], canaries[key]);
  assert.equal(api.TEST_DATABASE_URL, undefined);
  for (const scope of ["worker", "migrator"]) {
    const env = serviceEnv(scope, { directory, inherited: canaries });
    assert.deepEqual(env, { DATABASE_URL: canaries.DATABASE_URL });
  }
});

test("injected values override scoped files, scoped files override legacy, without mutation", (t) => {
  const directory = fixture(t, {
    ".env": "OPENAI_API_KEY=legacy\nDATABASE_URL=pglite://legacy",
    ".env.api": "OPENAI_API_KEY=scoped\nDATABASE_URL=pglite://api",
    ".env.migrator": "DATABASE_URL=pglite://migrator",
    ".env.worker": "DATABASE_URL=postgresql://localhost/worker",
  });
  const inherited = { OPENAI_API_KEY: "injected", API_PORT: "4100" };
  const api = serviceEnv("api", { directory, inherited });
  assert.equal(api.OPENAI_API_KEY, "injected");
  assert.equal(api.DATABASE_URL, "pglite://" + resolve(directory, "api"));
  assert.deepEqual(inherited, { OPENAI_API_KEY: "injected", API_PORT: "4100" });
  assert.equal(
    serviceEnv("api", { directory, inherited: {} }).OPENAI_API_KEY,
    "scoped",
  );
  assert.equal(
    serviceEnv("migrator", { directory, inherited: {} }).DATABASE_URL,
    "pglite://" + resolve(directory, "migrator"),
  );
  assert.equal(
    serviceEnv("worker", { directory, inherited: {} }).DATABASE_URL,
    "postgresql://localhost/worker",
  );
});

test("API file DB fallback and clean-clone defaults resolve from repo root, not cwd", (t) => {
  const empty = fixture(t);
  assert.equal(
    serviceEnv("migrator", { directory: empty, inherited: {} }).DATABASE_URL,
    "pglite://" + resolve(empty, ".local/database"),
  );
  assert.equal(
    serviceEnv("worker", { directory: empty, inherited: {} }).DATABASE_URL,
    undefined,
  );
  const directory = fixture(t, {
    ".env.api": "DATABASE_URL=pglite://shared\nOPENAI_API_KEY=unused",
  });
  for (const scope of ["api", "migrator", "worker"]) {
    assert.equal(
      serviceEnv(scope, { directory, inherited: {} }).DATABASE_URL,
      "pglite://" + resolve(directory, "shared"),
    );
    assert.equal(
      serviceEnv(scope, {
        directory,
        inherited: { DATABASE_URL: "pglite://:memory:" },
      }).DATABASE_URL,
      "pglite://:memory:",
    );
  }
});

test("tests never parse any runtime file, including invalid scoped settings", (t) => {
  const directory = fixture(t, {
    ".env": serialized,
    ".env.api": serialized,
    ".env.web": serialized,
    ".env.worker": serialized,
    ".env.migrator": serialized,
    ".env.mobile": serialized,
  });
  const env = serviceEnv("test", {
    directory,
    inherited: { ...canaries, NODE_ENV: "production" },
  });
  assert.deepEqual(env, {
    NODE_ENV: "test",
    TEST_DATABASE_URL: canaries.TEST_DATABASE_URL,
  });
  assert.deepEqual(serviceEnv("web-test", { directory, inherited: canaries }), {
    NODE_ENV: "production",
    API_INTERNAL_URL: "http://127.0.0.1:4000",
  });
});

test("only the selected public/routing variables survive, never public-prefix wildcards", (t) => {
  const directory = fixture(t, {
    ".env.web": "API_INTERNAL_URL=http://127.0.0.1:4200\nPORT=3200",
    ".env.mobile": "EXPO_PUBLIC_API_URL=https://api.example.test",
  });
  assert.deepEqual(serviceEnv("build", { directory, inherited: canaries }), {
    API_INTERNAL_URL: "http://127.0.0.1:4200",
  });
  assert.equal(serviceEnv("web", { directory, inherited: {} }).PORT, "3200");
  assert.deepEqual(serviceEnv("mobile", { directory, inherited: canaries }), {
    EXPO_PUBLIC_API_URL: "https://api.example.test",
    EXPO_NO_DOTENV: "1",
  });
});

test("scoped-file typos and secrets fail without revealing names or values", (t) => {
  for (const scope of ["api", "web", "mobile", "worker", "migrator"]) {
    const directory = fixture(t, {
      [`.env.${scope}`]: "UNKNOWN_SECRET=do-not-print-this",
    });
    assert.throws(
      () => serviceEnv(scope, { directory, inherited: {} }),
      (error) => {
        assert.match(error.message, /Unsupported setting/);
        assert.doesNotMatch(error.message, /UNKNOWN_SECRET|do-not-print-this/);
        return true;
      },
    );
  }
});

test("Next auto-loaded files are rejected, preserved and never read into env", (t) => {
  for (const name of [
    ".env",
    ".env.local",
    ".env.production.local",
    ".env.test",
  ]) {
    const directory = fixture(t, {
      [`apps/web/${name}`]: "OPENAI_API_KEY=never-print",
    });
    for (const scope of ["build", "web", "web-test"])
      assert.throws(
        () => serviceEnv(scope, { directory, inherited: {} }),
        /framework auto-loading/,
      );
    assert.equal(
      readFileSync(join(directory, "apps/web", name), "utf8"),
      "OPENAI_API_KEY=never-print",
    );
  }
});

test("scope validation, explicit mode override and Windows system variables", (t) => {
  const directory = fixture(t);
  assert.throws(
    () => serviceEnv("typo", { directory }),
    /Unknown environment scope/,
  );
  const env = serviceEnv("api", {
    directory,
    inherited: {
      NODE_ENV: "development",
      PATH: "path",
      SystemRoot: "C:\\Windows",
    },
    overrides: { NODE_ENV: "production", FUTURE_PROVIDER_KEY: "must-drop" },
  });
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.PATH, "path");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.FUTURE_PROVIDER_KEY, undefined);
  assert.throws(
    () =>
      serviceEnv("web", {
        directory,
        inherited: { NODE_ENV: "custom-env-file" },
      }),
    /Unsupported Web NODE_ENV/,
  );
  if (process.platform === "win32")
    assert.equal(
      serviceEnv("test", { directory, inherited: { Path: "windows-path" } })
        .PATH,
      "windows-path",
    );
});

test("API schema and environment allowlist stay in sync", () => {
  const config = readFileSync(
    join(root, "packages/config/src/index.ts"),
    "utf8",
  );
  // Environment names can contain digits, e.g. R1_HOUSING_API_MODE.
  const keys = [...config.matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map(
    (match) => match[1],
  );
  assert.deepEqual([...apiKeys].sort(), keys.sort());
});

test("Turbo caches only non-secret Web configuration and passes the test DB only to API/DB tests", () => {
  const turbo = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8"));
  assert.equal(turbo.envMode, "strict");
  assert.equal(turbo.globalPassThroughEnv, undefined);
  assert.equal(turbo.globalEnv, undefined);
  assert.ok(!turbo.globalDependencies.includes(".env"));
  const databaseTasks = ["@citygo/api#test", "@citygo/db#test"];
  for (const name of databaseTasks) {
    assert.deepEqual(turbo.tasks[name].passThroughEnv, ["TEST_DATABASE_URL"]);
    assert.equal(turbo.tasks[name].cache, false);
  }
  for (const [name, task] of Object.entries(turbo.tasks)) {
    assert.deepEqual(
      task.passThroughEnv ?? [],
      databaseTasks.includes(name) ? ["TEST_DATABASE_URL"] : [],
    );
    assert.deepEqual(
      task.env ?? [],
      name.startsWith("@citygo/web#")
        ? ["API_INTERNAL_URL", "CITYGO_WEB_STANDALONE"]
        : [],
    );
  }
  assert.ok(
    turbo.tasks["@citygo/web#build"].inputs.includes("$TURBO_ROOT$/.env.web"),
  );
});

test("real child processes see the scoped canaries, not the supervisor's full environment", (t) => {
  const directory = fixture(t, {
    ".env": serialized,
    "probe.mjs": "console.log(JSON.stringify(process.env));",
  });
  mkdirSync(join(directory, "scripts"));
  for (const file of ["env.mjs", "with-env.mjs", "process.mjs"])
    copyFileSync(join(root, "scripts", file), join(directory, "scripts", file));
  const inherited = {
    ...serviceEnv("test", { directory, inherited: process.env }),
    ...canaries,
  };
  // Do not let the intentionally invalid NODE_OPTIONS affect the supervisor itself.
  delete inherited.NODE_OPTIONS;
  for (const scope of [
    "api",
    "web",
    "build",
    "worker",
    "migrator",
    "test",
    "mobile",
    "web-test",
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(directory, "scripts/with-env.mjs"), scope, "node", "probe.mjs"],
      {
        cwd: directory,
        env: inherited,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const env = JSON.parse(result.stdout);
    for (const key of Object.keys(canaries)) {
      const expected =
        (scope === "api" && apiKeys.includes(key)) ||
        (["worker", "migrator"].includes(scope) && key === "DATABASE_URL") ||
        (scope === "test" && key === "TEST_DATABASE_URL");
      assert.equal(
        env[key],
        expected ? canaries[key] : undefined,
        `${scope}/${key}`,
      );
    }
  }
});

test("node/pnpm child commands preserve arguments and reject shell executables", () => {
  assert.deepEqual(commandArgs("node", ["file with spaces.mjs"]), [
    "file with spaces.mjs",
  ]);
  assert.deepEqual(
    commandArgs("pnpm", ["exec", "tool"], { npm_execpath: "pnpm.cjs" }),
    ["pnpm.cjs", "exec", "tool"],
  );
  assert.throws(() => commandArgs("pnpm", [], {}), /through pnpm/);
  assert.throws(() => commandArgs("cmd", [], {}), /only node\/pnpm/);
});

test("launcher reports child failure and removes its signal listeners", async (t) => {
  const directory = fixture(t);
  const before = [
    process.listenerCount("SIGTERM"),
    process.listenerCount("SIGINT"),
  ];
  await assert.rejects(
    launch("node", ["-e", "process.exit(7)"], {
      cwd: directory,
      env: serviceEnv("test", { directory, inherited: process.env }),
    }).done,
    /Child command failed \(7\)/,
  );
  assert.deepEqual(
    [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")],
    before,
  );
});

test("launcher can stop its own long-running child and clean signal handlers", async (t) => {
  const directory = fixture(t);
  const before = process.listenerCount("SIGTERM");
  const task = launch("node", ["-e", "setTimeout(() => {}, 30000)"], {
    cwd: directory,
    env: serviceEnv("test", { directory, inherited: process.env }),
  });
  const done = assert.rejects(task.done, /Child command failed/);
  task.stop();
  await done;
  assert.equal(process.listenerCount("SIGTERM"), before);
});

test(
  "Linux launcher keeps forwarding repeated signals until its child completes",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const directory = fixture(t);
    const marker = join(directory, "signals.txt");
    const before = process.listenerCount("SIGTERM");
    const task = launch(
      "node",
      [
        "--input-type=module",
        "-e",
        `
    import { writeFileSync } from 'node:fs';
    let count = 0;
    const marker = ${JSON.stringify(marker)};
    process.on('SIGTERM', () => {
      writeFileSync(marker, String(++count));
      if (count === 2) process.exit(0);
    });
    writeFileSync(marker, '0');
    setInterval(() => {}, 1000);
  `,
      ],
      {
        cwd: directory,
        env: serviceEnv("test", { directory, inherited: process.env }),
      },
    );
    task.done.catch(() => {});
    t.after(async () => {
      task.stop("SIGKILL");
      await task.done.catch(() => {});
    });
    async function waitFor(value) {
      const deadline = Date.now() + 3000;
      while (!existsSync(marker) || readFileSync(marker, "utf8") !== value) {
        assert.ok(
          Date.now() < deadline,
          "child did not receive the expected signal",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await waitFor("0");
    process.emit("SIGTERM");
    await waitFor("1");
    assert.equal(process.listenerCount("SIGTERM"), before + 1);
    process.emit("SIGTERM");
    await task.done;
    assert.equal(readFileSync(marker, "utf8"), "2");
    assert.equal(process.listenerCount("SIGTERM"), before);
  },
);

test("migration CLI cannot silently restore the broad root dotenv", () => {
  assert.doesNotMatch(
    readFileSync(join(root, "packages/db/src/cli.ts"), "utf8"),
    /import\s+["']dotenv|loadEnvFile/,
  );
});

test("root dev/start/migrate route only the required settings to each stage", (t) => {
  for (const mode of ["dev", "start", "migrate"]) {
    const directory = fixture(t, {
      ".env": serialized + "\nAPI_PORT=4100\nNODE_ENV=development",
      "pnpm.mjs": `
        import { writeFileSync, existsSync } from 'node:fs';
        import { fileURLToPath } from 'node:url';
        import { join } from 'node:path';
        const root = fileURLToPath(new URL('./', import.meta.url));
        const args = process.argv.slice(2);
        const stage = args[0] === 'turbo' ? 'build' : args[1].split('/')[1];
        writeFileSync(join(root, stage + '.json'), JSON.stringify(process.env));
        if (stage !== 'build') {
          const peer = stage === 'api' ? 'web' : 'api';
          const end = Date.now() + 3000;
          while (!existsSync(join(root, peer + '.json')) && Date.now() < end)
            await new Promise(r => setTimeout(r, 20));
          await new Promise(r => setTimeout(r, 100));
        }
      `,
      "packages/db/dist/cli.js": `
        require('node:fs').writeFileSync('migrator.json', JSON.stringify(process.env));
      `,
    });
    mkdirSync(join(directory, "scripts"));
    for (const file of ["env.mjs", "run.mjs", "process.mjs"])
      copyFileSync(
        join(root, "scripts", file),
        join(directory, "scripts", file),
      );
    const result = spawnSync(
      process.execPath,
      [join(directory, "scripts/run.mjs"), mode],
      {
        cwd: directory,
        env: {
          ...serviceEnv("test", { directory, inherited: process.env }),
          npm_execpath: join(directory, "pnpm.mjs"),
        },
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    if (mode !== "start") {
      const build = JSON.parse(
        readFileSync(join(directory, "build.json"), "utf8"),
      );
      const migrate = JSON.parse(
        readFileSync(join(directory, "migrator.json"), "utf8"),
      );
      assert.equal(build.DATABASE_URL, undefined);
      assert.equal(build.OPENAI_API_KEY, undefined);
      assert.equal(migrate.DATABASE_URL, canaries.DATABASE_URL);
      assert.equal(migrate.OPENAI_API_KEY, undefined);
    }
    if (mode !== "migrate") {
      const api = JSON.parse(readFileSync(join(directory, "api.json"), "utf8"));
      const web = JSON.parse(readFileSync(join(directory, "web.json"), "utf8"));
      assert.equal(api.OPENAI_API_KEY, canaries.OPENAI_API_KEY);
      assert.equal(api.DATABASE_URL, canaries.DATABASE_URL);
      assert.equal(
        api.NODE_ENV,
        mode === "start" ? "production" : "development",
      );
      assert.equal(web.DATABASE_URL, undefined);
      assert.equal(web.OPENAI_API_KEY, undefined);
      assert.equal(web.API_INTERNAL_URL, "http://127.0.0.1:4100");
      assert.equal(web.NODE_ENV, api.NODE_ENV);
    }
  }
});
