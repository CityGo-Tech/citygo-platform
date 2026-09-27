// Disposable PostgreSQL only. Dummy key, INTERNAL database network, no provider
// egress, registration, model requests, credits or budget approval.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./env.mjs";
import { until } from "./container-drain-smoke.mjs";

export async function routerAiProfileSmoke({
  project,
  directory,
  apiImage,
  docker,
  psql,
}) {
  assert.match(project, /^citygo-pilot-test-[a-f0-9]{12}$/);
  const network = `${project}_database`;
  assert.equal(
    docker(["network", "inspect", "--format", "{{.Internal}}", network]).trim(),
    "true",
  );
  const profile = JSON.parse(
    readFileSync(
      join(root, "deploy/fixtures/routerai-profile.fixture.json"),
      "utf8",
    ),
  );
  profile.DATABASE_URL = JSON.parse(
    readFileSync(join(directory, "api.json"), "utf8"),
  ).DATABASE_URL;
  // Compute only the public SYNTHETIC policy in a one-shot no-network process.
  // Real policy IDs must be independently approved; never copy this fixture.
  const publicSettings = Object.fromEntries(
    [
      "ROUTERAI_MODEL",
      "ROUTERAI_UPSTREAM",
      "ROUTERAI_COUNTRY",
      "ROUTERAI_DATA_NOTICE",
    ].map((k) => [k, profile[k]]),
  );
  const policy = JSON.parse(
    docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--entrypoint",
      "node",
      ...Object.entries(publicSettings).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]),
      apiImage,
      "dist/preview-policy.js",
    ]),
  ).id;
  assert.match(policy, /^[a-f0-9]{64}$/);
  profile.ROUTERAI_PRODUCTION_POLICY_ID = policy;
  const secret = join(directory, "routerai-api.json");
  writeFileSync(secret, JSON.stringify(profile), { mode: 0o444, flag: "wx" });
  const name = `${project}-routerai-profile`;
  const id = docker([
    "run",
    "-d",
    "--pull",
    "never",
    "--name",
    name,
    "--network",
    network,
    "--read-only",
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "1000:1000",
    "--pids-limit",
    "128",
    "--memory",
    "768m",
    "--stop-timeout",
    "330",
    "--restart",
    "no",
    "--tmpfs",
    "/tmp",
    "--mount",
    `type=bind,source=${secret},target=/run/secrets/api.json,readonly`,
    "-e",
    "CITYGO_MOUNTED_CONFIG=1",
    "-e",
    "CITYGO_AI_PROFILE=routerai-credit-v1",
    "-e",
    "LLM_PROVIDER=routerai",
    "-e",
    "API_HOST=0.0.0.0",
    "-e",
    "API_PORT=4000",
    "-e",
    "WEB_ORIGIN=https://pilot.example.test",
    "-e",
    "TRUSTED_PROXY_CIDRS=172.30.92.10/32",
    apiImage,
    "api",
  ]).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  try {
    await until(
      () =>
        docker([
          "inspect",
          "--format",
          "{{.State.Health.Status}}",
          id,
        ]).trim() === "healthy",
      "RouterAI mounted profile did not start",
      90000,
    );
    const proof = docker([
      "exec",
      id,
      "node",
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict'; const ready=await fetch('http://127.0.0.1:4000/ready'); assert.equal(ready.status,200); assert.equal((await fetch('http://127.0.0.1:4000/v1/admin/ai')).status,401); console.log('profile-ready-auth-closed');`,
    ]);
    assert.equal(proof.trim(), "profile-ready-auth-closed");
    assert.equal(psql("select enabled from ai_budget where id=1"), "f");
    assert.equal(psql("select count(*) from ai_model_attempts"), "0");
    assert.equal(psql("select count(*) from ai_credit_entries"), "0");
    // Inspect only key NAMES of the container environment, not mounted values.
    const env = JSON.parse(
      docker(["inspect", "--format", "{{json .Config.Env}}", id]),
    );
    assert.ok(
      !env.some((v) =>
        /^(ROUTERAI_API_KEY|OPENAI_API_KEY|GIGACHAT_CREDENTIALS|DATABASE_URL)=/.test(
          v,
        ),
      ),
    );
  } finally {
    // Exact container created above, not any pre-existing project/runtime.
    docker(["stop", "--time", "330", id], { timeout: 350000 });
    assert.equal(
      docker(["inspect", "--format", "{{.State.ExitCode}}", id]).trim(),
      "0",
    );
    docker(["rm", id]);
  }
  console.log(
    "RouterAI profile: production ready, authenticated routes closed, zero attempts/credits; network egress blocked",
  );
}
