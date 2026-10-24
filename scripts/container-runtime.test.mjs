import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { root, serviceEnv } from "./env.mjs";
import { containerSpec } from "./container-runtime.mjs";
import { renderNginx } from "../deploy/render-pilot.mjs";

const db = "postgresql://synthetic:test@127.0.0.1:1/not-used";

test("production container smoke expects the complete checked-in migration inventory", () => {
  const count = readdirSync(join(root, "packages/db/migrations")).filter(
    (name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name),
  ).length;
  const smoke = readFileSync(join(root, "scripts/container-smoke.mjs"), "utf8");
  const expected = /assert\.equal\(migrations, "(\d+)"\)/.exec(smoke);
  assert.ok(expected, "Keep the smoke migration target explicit and reviewed");
  assert.equal(Number(expected[1]), count);
});

test("release jobs include only the reviewed PostgreSQL grants build input", () => {
  const ignore = readFileSync(join(root, ".dockerignore"), "utf8");
  assert.match(
    ignore,
    /deploy\/postgres\/\*\r?\n!deploy\/postgres\/grants\.sql/,
  );
  assert.doesNotMatch(ignore, /^!deploy\/postgres\/(?:\*|\*\*)$/m);
  const dockerfile = readFileSync(join(root, "deploy/Dockerfile"), "utf8");
  assert.match(
    dockerfile.split("FROM runtime AS jobs")[1],
    /COPY --chown=node:node deploy\/postgres\/grants\.sql \.\/release-grants\.sql/,
  );
});

test("API container stop allows the complete drain and cleanup deadline", () => {
  for (const name of ["compose.pilot.yml", "compose.smoke.yml"]) {
    const compose = readFileSync(join(root, "deploy", name), "utf8");
    const api = compose.split("\n  api:\n")[1]?.split("\n  web:\n")[0];
    assert.match(api ?? "", /stop_grace_period: 330s/);
  }
});
test("Worker container stop allows the complete transaction and close deadline", () => {
  for (const name of ["compose.pilot.yml", "compose.smoke.yml"]) {
    const compose = readFileSync(join(root, "deploy", name), "utf8");
    const worker = compose.split("\n  worker:\n")[1]?.split("\n  backup:\n")[0];
    assert.match(worker ?? "", /stop_grace_period: 90s/);
  }
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "citygo-container-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("mounted service config is explicit, closed, secret-safe and never available to Web", (t) => {
  const directory = fixture(t);
  for (const mode of ["api", "migrate", "worker"])
    writeFileSync(
      join(directory, `${mode}.json`),
      JSON.stringify({ DATABASE_URL: db }),
    );
  const injected = { CITYGO_MOUNTED_CONFIG: "1", LLM_PROVIDER: "disabled" };
  for (const mode of ["api", "migrate", "migrate-release", "worker"]) {
    const spec = containerSpec(mode, injected, directory, directory);
    assert.equal(spec.env.DATABASE_URL, db);
    assert.equal(spec.env.CITYGO_MOUNTED_CONFIG, undefined);
    assert.equal(spec.env.NODE_ENV, "production");
    assert.throws(
      () =>
        containerSpec(
          mode,
          { ...injected, DATABASE_URL: db },
          directory,
          directory,
        ),
      /Invalid mounted/,
    );
  }
  assert.throws(
    () => containerSpec("web", injected, directory, directory),
    /Invalid mounted/,
  );
  for (const value of [
    "{}",
    "null",
    "[]",
    "invalid",
    JSON.stringify({ DATABASE_URL: db, NODE_ENV: "development" }),
    JSON.stringify({
      DATABASE_URL: db,
      OPENAI_API_KEY: "synthetic-hidden-secret",
    }),
  ]) {
    writeFileSync(join(directory, "worker.json"), value);
    assert.throws(
      () => containerSpec("worker", injected, directory, directory),
      (error) => {
        assert.match(error.message, /Invalid mounted/);
        assert.doesNotMatch(
          error.message,
          /synthetic-hidden-secret|postgresql/,
        );
        return true;
      },
    );
  }
  writeFileSync(
    join(directory, "api.json"),
    JSON.stringify({
      DATABASE_URL: db,
      OPENAI_API_KEY: "synthetic-hidden-secret",
    }),
  );
  const api = containerSpec("api", injected, directory, directory);
  assert.equal(api.env.OPENAI_API_KEY, "synthetic-hidden-secret");
  assert.equal(api.env.LLM_PROVIDER, "disabled");
  rmSync(join(directory, "api.json"));
  assert.throws(
    () => containerSpec("api", injected, directory, directory),
    /Invalid mounted/,
  );
});

for (const [marker, file] of [
  ["routerai-credit-v1", "routerai-profile.fixture.json"],
  ["routerai-citygo-10x-v1", "routerai-citygo-10x-profile.fixture.json"],
])
  test(`RouterAI ${marker} requires a complete pinned API-only mounted config`, (t) => {
    const directory = fixture(t);
    const value = JSON.parse(
      readFileSync(join(root, "deploy/fixtures", file), "utf8"),
    );
    const inherited = {
      CITYGO_MOUNTED_CONFIG: "1",
      CITYGO_AI_PROFILE: marker,
      LLM_PROVIDER: "routerai",
    };
    const write = (data) =>
      writeFileSync(join(directory, "api.json"), JSON.stringify(data));
    const spec = (extra = {}, mode = "api") =>
      containerSpec(mode, { ...inherited, ...extra }, directory, directory);
    write(value);
    const env = spec().env;
    for (const [key, setting] of Object.entries(value))
      assert.equal(env[key], setting);
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.CITYGO_AI_PROFILE, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.GIGACHAT_CREDENTIALS, undefined);
    for (const mode of ["web", "worker", "migrate", "migrate-release"])
      assert.throws(() => spec({}, mode), /Invalid container AI profile/);
    for (const extra of [
      { CITYGO_MOUNTED_CONFIG: undefined },
      { CITYGO_AI_PROFILE: "unknown" },
      { LLM_PROVIDER: "disabled" },
      { OPENAI_API_KEY: "ambient-hidden" },
      { GIGACHAT_CREDENTIALS: "ambient-hidden" },
      { ROUTERAI_MODEL: value.ROUTERAI_MODEL },
      { LLM_USER_DAILY_REQUEST_LIMIT: "999" },
      { AI_CREDIT_MODE: "disabled" },
      { AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft" },
      { YOOKASSA_MODE: "disabled" },
      { YOOKASSA_SHOP_ID: "123456" },
      { YOOKASSA_SECRET_KEY: "test_ambient-hidden" },
    ])
      assert.throws(() => spec(extra), /Invalid container AI profile/);
    // The ordinary disabled profile cannot silently interpret the richer secret.
    assert.throws(
      () => spec({ CITYGO_AI_PROFILE: undefined, LLM_PROVIDER: "disabled" }),
      /Invalid mounted/,
    );
    for (const key of Object.keys(value)) {
      const missing = { ...value };
      delete missing[key];
      write(missing);
      assert.throws(() => spec(), /Invalid mounted/);
    }
    for (const patch of [
      { AI_CREDIT_MODE: "disabled" },
      {
        AI_CREDIT_MODE:
          marker === "routerai-credit-v1"
            ? "routerai_citygo_10x"
            : "routerai_at_cost",
      },
      { YOOKASSA_MODE: "test" },
      { YOOKASSA_MODE: "live" },
      { YOOKASSA_SHOP_ID: "123456" },
      { YOOKASSA_SECRET_KEY: "test_hidden-value" },
      { YOOKASSA_SECRET_KEY: "live_hidden-value" },
      { ROUTERAI_UPSTREAM: "other" },
      { ROUTERAI_COUNTRY: "ru" },
      { ROUTERAI_MODEL: "https://untrusted.test" },
      { ROUTERAI_REQUEST_TIMEOUT_MS: "240001" },
      { ROUTERAI_MAX_OUTPUT_TOKENS: "32769" },
      { ROUTERAI_REASONING_EFFORT: "low" },
      { ROUTERAI_PRODUCTION_POLICY_ID: "true" },
      { ROUTERAI_DATA_NOTICE: " " },
      { ROUTERAI_DATA_NOTICE: "x".repeat(4001) },
      { ROUTERAI_API_KEY: "hidden\nvalue" },
      { ADMIN_USER_IDS: "1,1" },
      { ADMIN_USER_IDS: "0001" },
      { ADMIN_USER_IDS: "00000000-0000-4000-8000-000000000001" },
      { LLM_USER_DAILY_ATTEMPT_LIMIT: "10001" },
      { LLM_GLOBAL_DAILY_REQUEST_LIMIT: "1e6" },
      { OPENAI_API_KEY: "hidden-value" },
      { ROUTERAI_BASE_URL: "https://untrusted.test" },
    ]) {
      write({ ...value, ...patch });
      assert.throws(
        () => spec(),
        (error) => {
          assert.match(error.message, /Invalid mounted/);
          assert.doesNotMatch(
            error.message,
            /hidden-value|synthetic-not-live|postgresql/,
          );
          return true;
        },
      );
    }
    write(value);
    // A valid secret under one tariff cannot be selected using the other marker.
    assert.throws(
      () =>
        spec({
          CITYGO_AI_PROFILE:
            marker === "routerai-credit-v1"
              ? "routerai-citygo-10x-v1"
              : "routerai-credit-v1",
        }),
      /Invalid mounted/,
    );
  });

const liveMountedProfiles = [
  [
    "routerai-citygo-10x-yookassa-live-v1",
    "routerai-citygo-10x-yookassa-live-profile.fixture.json",
    "cn",
  ],
  [
    "routerai-citygo-10x-yookassa-live-cn-v1",
    "routerai-citygo-10x-yookassa-live-cn-profile.fixture.json",
    "us",
  ],
  [
    "routerai-citygo-10x-yookassa-live-cn-fiscal-v2",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-profile.fixture.json",
    "us",
  ],
  [
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-profile.fixture.json",
    "us",
  ],
  [
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1",
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-profile.fixture.json",
    "us",
  ],
];
for (const [marker, file, rejectedCountry] of liveMountedProfiles)
  test(`live YooKassa ${marker} requires its exact API-only profile and never inherits credentials`, (t) => {
    const directory = fixture(t);
    const value = JSON.parse(
      readFileSync(join(root, "deploy/fixtures", file), "utf8"),
    );
    const inherited = {
      CITYGO_MOUNTED_CONFIG: "1",
      CITYGO_AI_PROFILE: marker,
      LLM_PROVIDER: "routerai",
      WEB_ORIGIN: "https://pilot.example.test",
    };
    const write = (data) =>
      writeFileSync(join(directory, "api.json"), JSON.stringify(data));
    const spec = (extra = {}, mode = "api") =>
      containerSpec(mode, { ...inherited, ...extra }, directory, directory);
    write(value);
    const env = spec().env;
    for (const [key, setting] of Object.entries(value))
      assert.equal(env[key], setting);
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.CITYGO_AI_PROFILE, undefined);
    assert.equal(env.YOOKASSA_MODE, "live");
    assert.equal(env.YOOKASSA_RECEIPT_MODE, "npd_manual");
    for (const key of ["OPENAI_API_KEY", "GIGACHAT_CREDENTIALS"])
      assert.equal(env[key], undefined);
    for (const key of Object.keys(value)) {
      const missing = { ...value };
      delete missing[key];
      write(missing);
      assert.throws(() => spec(), /Invalid mounted/);
    }
    for (const patch of [
      { AI_CREDIT_MODE: "disabled" },
      { AI_CREDIT_MODE: "routerai_at_cost" },
      { AI_CREDIT_RESERVATION_MODE: "full" },
      { AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft " },
      { YOOKASSA_MODE: "test" },
      { YOOKASSA_MODE: "disabled" },
      { YOOKASSA_RECEIPT_MODE: "disabled" },
      { YOOKASSA_RECEIPT_MODE: "npd_partner" },
      { YOOKASSA_FISCAL_PROFILE: "disabled" },
      { YOOKASSA_FISCAL_PROFILE: "unknown" },
      { YOOKASSA_TAX_SYSTEM_CODE: "1" },
      { YOOKASSA_SHOP_ID: "0" },
      { YOOKASSA_SHOP_ID: "000123" },
      { YOOKASSA_SHOP_ID: "1".repeat(21) },
      { YOOKASSA_SECRET_KEY: "test_SYNTHETIC_NOT_A_REAL_KEY" },
      { YOOKASSA_SECRET_KEY: "live_short" },
      { YOOKASSA_SECRET_KEY: "live_" + "x".repeat(8193) },
      { YOOKASSA_SECRET_KEY: "live_hidden\nvalue" },
      { YOOKASSA_BASE_URL: "https://untrusted.test" },
      { YOOKASSA_RETURN_URL: "https://untrusted.test" },
      { WEB_ORIGIN: "https://untrusted.test" },
      { ROUTERAI_MODEL: "other" },
      { ROUTERAI_MODEL: "deepseek/deepseek-v4-flash" },
      { ROUTERAI_MODEL: "~deepseek/deepseek-v4-pro-latest" },
      { ROUTERAI_UPSTREAM: "other" },
      { ROUTERAI_COUNTRY: "ru" },
      { ROUTERAI_COUNTRY: rejectedCountry },
      {
        ROUTERAI_MAX_OUTPUT_TOKENS: String(
          Number(value.ROUTERAI_MAX_OUTPUT_TOKENS) + 1,
        ),
      },
      { LLM_MAX_INPUT_BYTES: String(Number(value.LLM_MAX_INPUT_BYTES) + 1) },
      { ROUTERAI_REQUEST_TIMEOUT_MS: "240001" },
      { ROUTERAI_REASONING_EFFORT: "max" },
      { ROUTERAI_API_KEY: "hidden\nvalue" },
      { ROUTERAI_PRODUCTION_POLICY_ID: "true" },
      { ROUTERAI_DATA_NOTICE: " " },
      { LLM_GLOBAL_DAILY_ATTEMPT_LIMIT: "1000001" },
      { OPENAI_API_KEY: "hidden-value" },
    ]) {
      write({ ...value, ...patch });
      assert.throws(
        () => spec(),
        (error) => {
          assert.match(error.message, /Invalid mounted/);
          assert.doesNotMatch(
            error.message,
            /SYNTHETIC|hidden-value|postgresql/,
          );
          return true;
        },
      );
    }
    write(value);
    for (const mode of ["web", "worker", "migrate", "migrate-release"])
      assert.throws(() => spec({}, mode), /Invalid container AI profile/);
    for (const extra of [
      { CITYGO_MOUNTED_CONFIG: undefined },
      { LLM_PROVIDER: "disabled" },
      { YOOKASSA_SHOP_ID: value.YOOKASSA_SHOP_ID },
      { YOOKASSA_SECRET_KEY: value.YOOKASSA_SECRET_KEY },
      { ROUTERAI_API_KEY: value.ROUTERAI_API_KEY },
      { YOOKASSA_MODE: "live" },
      { AI_CREDIT_MODE: value.AI_CREDIT_MODE },
      { AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft" },
      { AI_CREDIT_UNREVIEWED_SETTING: "ambient-hidden" },
    ])
      assert.throws(() => spec(extra), /Invalid container AI profile/);
    for (const profile of [
      undefined,
      "routerai-credit-v1",
      "routerai-citygo-10x-v1",
      ...liveMountedProfiles
        .map(([profile]) => profile)
        .filter((profile) => profile !== marker),
    ])
      assert.throws(
        () => spec({ CITYGO_AI_PROFILE: profile }),
        /Invalid mounted/,
      );
    // Independent credential bounds (the overall secret cap remains 16 KiB).
    write({
      ...value,
      YOOKASSA_SHOP_ID: "1".repeat(20),
      YOOKASSA_SECRET_KEY: "live_" + "x".repeat(8192),
    });
    assert.equal(spec().env.YOOKASSA_SECRET_KEY.length, 8197);
  });

test("overdraft profile changes only explicit billing-risk mode, never legacy markers or receipts", () => {
  const read = (name) =>
    JSON.parse(readFileSync(join(root, "deploy/fixtures", name), "utf8"));
  const legacy = read(
    "routerai-citygo-10x-yookassa-live-cn-fiscal-profile.fixture.json",
  );
  const overdraft = read(
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-profile.fixture.json",
  );
  assert.deepEqual(overdraft, {
    ...legacy,
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  });
  assert.equal(legacy.AI_CREDIT_RESERVATION_MODE, undefined);
  assert.equal(
    overdraft.YOOKASSA_FISCAL_PROFILE,
    "citygo_service_full_payment_v1",
  );
  assert.equal(overdraft.ROUTERAI_MAX_OUTPUT_TOKENS, "4096");
});

test("email-only mounted profile preserves v7 and rejects partial credentials, SMS, unsafe From and count caps", (t) => {
  const directory = fixture(t);
  const read = (name) =>
    JSON.parse(readFileSync(join(root, "deploy/fixtures", name), "utf8"));
  const legacy = read(
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-profile.fixture.json",
  );
  const value = read(
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-profile.fixture.json",
  );
  const extra = Object.fromEntries(
    Object.entries(value).filter(([key]) => !(key in legacy)),
  );
  assert.deepEqual(value, { ...legacy, ...extra });
  assert.deepEqual(
    Object.keys(extra).sort(),
    [
      "EMAIL_REGISTRATION_MODE",
      "EMAIL_DELIVERY_PROVIDER",
      "POSTBOX_FROM_EMAIL",
      "PHONE_VERIFICATION_MODE",
      "SMS_RU_MODE",
      "EMAIL_REGISTRATION_SECRET",
      "POSTBOX_ACCESS_KEY_ID",
      "POSTBOX_SECRET_ACCESS_KEY",
      "EMAIL_SEND_DAILY_LIMIT",
      "EMAIL_SEND_TOTAL_LIMIT",
    ].sort(),
  );
  const inherited = {
    CITYGO_MOUNTED_CONFIG: "1",
    CITYGO_AI_PROFILE:
      "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1",
    LLM_PROVIDER: "routerai",
  };
  const spec = (data) => {
    writeFileSync(join(directory, "api.json"), JSON.stringify(data));
    return containerSpec("api", inherited, directory, directory);
  };
  assert.equal(spec(value).env.EMAIL_REGISTRATION_MODE, "required");
  for (const patch of [
    { EMAIL_REGISTRATION_MODE: "disabled" },
    { EMAIL_DELIVERY_PROVIDER: "disabled" },
    { POSTBOX_FROM_EMAIL: "other@xn--c1ajazlh.xn--p1ai" },
    { POSTBOX_FROM_EMAIL: "no-reply@ситиго.рф" },
    {
      POSTBOX_FROM_EMAIL:
        "no-reply@xn--c1ajazlh.xn--p1ai\r\nBcc:other@example.test",
    },
    { POSTBOX_ACCESS_KEY_ID: "short" },
    { POSTBOX_ACCESS_KEY_ID: "x".repeat(129) },
    { POSTBOX_SECRET_ACCESS_KEY: "short" },
    { POSTBOX_SECRET_ACCESS_KEY: "x".repeat(257) },
    { POSTBOX_SECRET_ACCESS_KEY: "secret with space" },
    { EMAIL_REGISTRATION_SECRET: "B".repeat(64) },
    { EMAIL_REGISTRATION_SECRET: "b".repeat(63) },
    { EMAIL_SEND_DAILY_LIMIT: "0" },
    { EMAIL_SEND_DAILY_LIMIT: "01" },
    { EMAIL_SEND_DAILY_LIMIT: "100001" },
    { EMAIL_SEND_TOTAL_LIMIT: "1000001" },
    { EMAIL_SEND_TOTAL_LIMIT: "1e3" },
    { EMAIL_SEND_TOTAL_LIMIT: 2 },
    { PHONE_VERIFICATION_MODE: "sms_ru" },
    { SMS_RU_MODE: "test" },
    { SMS_RU_API_ID: "synthetic-must-not-be-present" },
    { PHONE_VERIFICATION_SECRET: "c".repeat(64) },
  ])
    assert.throws(() => spec({ ...value, ...patch }), /Invalid mounted/);
  const maximum = spec({
    ...value,
    EMAIL_SEND_DAILY_LIMIT: "100000",
    EMAIL_SEND_TOTAL_LIMIT: "1000000",
  });
  assert.equal(maximum.env.EMAIL_SEND_TOTAL_LIMIT, "1000000");
});

test("email-only v8 accepts only exact unlimited or its bounded canonical decimal limits", (t) => {
  const directory = fixture(t);
  const marker =
    "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1";
  const value = JSON.parse(
    readFileSync(
      join(
        root,
        "deploy/fixtures/routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-profile.fixture.json",
      ),
      "utf8",
    ),
  );
  const limits = {
    EMAIL_SEND_DAILY_LIMIT: "100000",
    EMAIL_SEND_TOTAL_LIMIT: "1000000",
  };
  const spec = (data, profile = marker) => {
    writeFileSync(join(directory, "api.json"), JSON.stringify(data));
    return containerSpec(
      "api",
      {
        CITYGO_MOUNTED_CONFIG: "1",
        ...(profile === null ? {} : { CITYGO_AI_PROFILE: profile }),
        LLM_PROVIDER: profile ? "routerai" : "disabled",
      },
      directory,
      directory,
    );
  };
  for (const [daily, total] of [
    ["unlimited", "unlimited"],
    ["unlimited", "1"],
    ["1", "unlimited"],
    ["unlimited", limits.EMAIL_SEND_TOTAL_LIMIT],
    [limits.EMAIL_SEND_DAILY_LIMIT, "unlimited"],
    ["1", "1"],
    Object.values(limits),
  ]) {
    const mounted = spec({
      ...value,
      EMAIL_SEND_DAILY_LIMIT: daily,
      EMAIL_SEND_TOTAL_LIMIT: total,
    });
    assert.equal(mounted.env.EMAIL_SEND_DAILY_LIMIT, daily);
    assert.equal(mounted.env.EMAIL_SEND_TOTAL_LIMIT, total);
  }
  for (const key of Object.keys(limits)) {
    const missing = { ...value };
    delete missing[key];
    assert.throws(() => spec(missing), /Invalid mounted/);
    for (const invalid of [
      "",
      "UNLIMITED",
      "Unlimited",
      " unlimited",
      "unlimited ",
      "unlimited\n",
      "unlimited\0",
      "unlimited\u200b",
      "unlіmited",
      "Infinity",
      "NaN",
      "0",
      "-1",
      "+1",
      "01",
      "1.0",
      "1e3",
      "0x10",
      "١",
      "１",
      String(Number(limits[key]) + 1),
      0,
      2,
      true,
      false,
      null,
      {},
      [],
      ["unlimited"],
    ])
      assert.throws(
        () => spec({ ...value, [key]: invalid }),
        /Invalid mounted/,
        `${key} must not reinterpret ${JSON.stringify(invalid)}`,
      );
  }
  // The sentinel belongs only to the two email fields, not SMS or AI quotas.
  for (const key of [
    "PHONE_SMS_GLOBAL_DAILY_LIMIT",
    "PHONE_SMS_GLOBAL_TOTAL_LIMIT",
    "PHONE_VERIFICATION_MODE",
    "SMS_RU_MODE",
    "LLM_USER_DAILY_REQUEST_LIMIT",
    "LLM_GLOBAL_DAILY_REQUEST_LIMIT",
    "LLM_USER_DAILY_ATTEMPT_LIMIT",
    "LLM_GLOBAL_DAILY_ATTEMPT_LIMIT",
  ])
    assert.throws(
      () => spec({ ...value, [key]: "unlimited" }),
      /Invalid mounted/,
    );
  for (const [oldMarker, file] of [
    ["routerai-credit-v1", "routerai-profile.fixture.json"],
    ["routerai-citygo-10x-v1", "routerai-citygo-10x-profile.fixture.json"],
    ...liveMountedProfiles.filter(([profile]) => profile !== marker),
  ]) {
    const legacy = JSON.parse(
      readFileSync(join(root, "deploy/fixtures", file), "utf8"),
    );
    assert.doesNotThrow(() => spec(legacy, oldMarker));
    for (const key of Object.keys(limits))
      assert.throws(
        () => spec({ ...legacy, [key]: "unlimited" }, oldMarker),
        /Invalid mounted/,
      );
    for (const key of [
      "LLM_USER_DAILY_REQUEST_LIMIT",
      "LLM_GLOBAL_DAILY_REQUEST_LIMIT",
      "LLM_USER_DAILY_ATTEMPT_LIMIT",
      "LLM_GLOBAL_DAILY_ATTEMPT_LIMIT",
    ])
      assert.throws(
        () => spec({ ...legacy, [key]: "unlimited" }, oldMarker),
        /Invalid mounted/,
      );
  }
  assert.doesNotThrow(() => spec({ DATABASE_URL: db }, null));
  for (const key of Object.keys(limits))
    assert.throws(
      () => spec({ DATABASE_URL: db, [key]: "unlimited" }, null),
      /Invalid mounted/,
    );
});

test("all mounted profiles, including disabled, refuse ambient verification prefixes", (t) => {
  const directory = fixture(t);
  for (const mode of ["api", "worker", "migrate"])
    writeFileSync(
      join(directory, `${mode}.json`),
      JSON.stringify({ DATABASE_URL: db }),
    );
  for (const mode of ["api", "web", "worker", "migrate", "migrate-release"])
    for (const key of [
      "EMAIL_REGISTRATION_MODE",
      "EMAIL_UNREVIEWED",
      "POSTBOX_ACCESS_KEY_ID",
      "PHONE_VERIFICATION_MODE",
      "SMS_RU_MODE",
      "SMS_UNREVIEWED",
    ])
      assert.throws(
        () =>
          containerSpec(
            mode,
            {
              CITYGO_MOUNTED_CONFIG: "1",
              LLM_PROVIDER: "disabled",
              [key]: "synthetic-ambient-secret",
            },
            directory,
            directory,
          ),
        /Invalid mounted verification/,
      );
  for (const [marker, file] of [
    ["routerai-credit-v1", "routerai-profile.fixture.json"],
    ...liveMountedProfiles.map(([marker, file]) => [marker, file]),
  ]) {
    writeFileSync(
      join(directory, "api.json"),
      readFileSync(join(root, "deploy/fixtures", file)),
    );
    for (const prefix of ["EMAIL_", "POSTBOX_", "PHONE_", "SMS_"])
      assert.throws(
        () =>
          containerSpec(
            "api",
            {
              CITYGO_MOUNTED_CONFIG: "1",
              CITYGO_AI_PROFILE: marker,
              LLM_PROVIDER: "routerai",
              [`${prefix}UNREVIEWED`]: "synthetic-ambient-secret",
            },
            directory,
            directory,
          ),
        /Invalid mounted verification/,
      );
  }
});

test("Nginx rendering rejects directives and sets bounded streaming/header rules", () => {
  for (const host of [
    "",
    "localhost",
    "127.0.0.1",
    "https://pilot.example.test",
    "*.example.test",
    "host.test;",
    "host.test\ninclude /tmp/evil;",
    "host.test:443",
  ])
    assert.throws(() => renderNginx(host));
  const config = renderNginx("pilot.example.test");
  assert.doesNotMatch(config, /__CITYGO_HOST__|proxy_add_x_forwarded_for/);
  assert.match(config, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(config, /proxy_read_timeout 300s;/);
  assert.match(config, /proxy_buffering off;/);
  assert.match(config, /proxy_next_upstream off;/);
  const next = readFileSync(join(root, "apps/web/next.config.mjs"), "utf8");
  assert.match(next, /proxyTimeout: 300000/);
});

test("container runtime ignores local env files and requires injected PostgreSQL for every DB mode", (t) => {
  const directory = fixture(t);
  for (const name of [".env", ".env.api", ".env.worker", ".env.migrator"])
    writeFileSync(
      join(directory, name),
      `DATABASE_URL=${db}\nOPENAI_API_KEY=never-load`,
    );
  for (const mode of ["api", "worker", "migrate", "migrate-release"]) {
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
  for (const mode of ["api", "web", "migrate", "migrate-release", "worker"]) {
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
  rmSync(join(nested, "source.txt"));
  for (const file of ["copied.age", "backup-storage.json"]) {
    writeFileSync(join(nested, file), "synthetic fixture");
    assert.equal(run().status, 1);
    rmSync(join(nested, file));
  }
  writeFileSync(
    join(nested, "identity.txt"),
    "AGE-SECRET-KEY-1" + "A".repeat(58),
  );
  const keyResult = run();
  assert.equal(keyResult.status, 1);
  assert.doesNotMatch(keyResult.stderr, /AGE-SECRET-KEY/);
});
