// Disposable PostgreSQL only. Dummy key, INTERNAL database network, no provider
// egress, model requests, credits or budget approval. The x10 check registers
// and deletes only its own synthetic account to prove payment/gift fail closed.
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
  for (const [marker, fixture] of [
    ["routerai-credit-v1", "routerai-profile.fixture.json"],
    ["routerai-citygo-10x-v1", "routerai-citygo-10x-profile.fixture.json"],
    [
      "routerai-citygo-10x-yookassa-live-v1",
      "routerai-citygo-10x-yookassa-live-profile.fixture.json",
    ],
  ])
    await mountedProfileSmoke({
      project,
      directory,
      apiImage,
      docker,
      psql,
      marker,
      fixture,
    });
}

async function mountedProfileSmoke({
  project,
  directory,
  apiImage,
  docker,
  psql,
  marker,
  fixture,
}) {
  assert.match(project, /^citygo-pilot-test-[a-f0-9]{12}$/);
  const network = `${project}_database`;
  assert.equal(
    docker(["network", "inspect", "--format", "{{.Internal}}", network]).trim(),
    "true",
  );
  const profile = JSON.parse(
    readFileSync(join(root, "deploy/fixtures", fixture), "utf8"),
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
  const secret = join(directory, `${marker}-api.json`);
  writeFileSync(secret, JSON.stringify(profile), { mode: 0o444, flag: "wx" });
  const name = `${project}-${marker}`;
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
    `CITYGO_AI_PROFILE=${marker}`,
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
    if (marker === "routerai-citygo-10x-v1")
      await closedPaymentsProof({ id, docker, psql });
    assert.equal(psql("select enabled from ai_budget where id=1"), "f");
    assert.equal(psql("select count(*) from ai_model_attempts"), "0");
    assert.equal(psql("select count(*) from ai_credit_entries"), "0");
    for (const table of [
      "payment_topup_orders",
      "ai_credit_topups",
      "payment_refunds",
      "npd_receipt_tasks",
      "payment_notification_inbox",
    ])
      assert.equal(psql(`select count(*) from ${table}`), "0");
    // Inspect only key NAMES of the container environment, not mounted values.
    const env = JSON.parse(
      docker(["inspect", "--format", "{{json .Config.Env}}", id]),
    );
    assert.ok(
      !env.some((v) =>
        /^(ROUTERAI_API_KEY|OPENAI_API_KEY|GIGACHAT_CREDENTIALS|DATABASE_URL|YOOKASSA_(?:SHOP_ID|SECRET_KEY))=/.test(
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
    `RouterAI ${marker}: production-mode startup verified, zero attempts/credits/payments; synthetic credentials only, network egress blocked`,
  );
}

async function closedPaymentsProof({ id, docker, psql }) {
  const email = "runtime-10x-fixture@example.test";
  assert.equal(
    psql(`select count(*) from user_credentials where email='${email}'`),
    "0",
  );
  const exec = (script) =>
    docker(["exec", id, "node", "--input-type=module", "-e", script]).trim();
  const setup = `
    import assert from 'node:assert/strict';
    const origin='https://pilot.example.test';
    const auth=await fetch('http://127.0.0.1:4000/v1/auth/register',{
      method:'POST',headers:{'content-type':'application/json','x-citygo-client':'native',origin},
      body:JSON.stringify({email:'${email}',password:'123456'})});
    assert.equal(auth.status,200);
    const {token,user}=await auth.json();
    const headers={authorization:'Bearer '+token,'content-type':'application/json',origin};
    const credit=await (await fetch('http://127.0.0.1:4000/v1/ai/credit',{headers})).json();
    assert.equal(credit.chargingStatus,'routerai_citygo_10x');
    assert.equal(credit.topUpAvailable,false);assert.equal(credit.bonusGranted,false);
    for(const key of ['grantedMicros','heldMicros','spentMicros','availableMicros'])assert.equal(credit[key],0);
    assert.deepEqual(credit.history,[]);
    assert.equal((await fetch('http://127.0.0.1:4000/v1/payments/topups',{
      method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),amountKopeks:10000})})).status,503);
    assert.equal((await fetch('http://127.0.0.1:4000/v1/admin/ai/credit/welcome',{
      method:'POST',headers,body:JSON.stringify({userId:user.id,confirmOneTime500Rub:true})})).status,403);
    console.log(user.id);`;
  const userId = exec(setup);
  assert.match(userId, /^[1-9][0-9]*$/);
  try {
    // Fixture-only role assignment in the disposable DB, not ADMIN_USER_IDS.
    const owned = `id=${userId} and exists(select 1 from user_credentials c where c.user_id=users.id and c.email='${email}')`;
    assert.equal(
      psql(`update users set role='admin' where ${owned} returning id`),
      `${userId}\nUPDATE 1`,
    );
    exec(`
      import assert from 'node:assert/strict';
      const origin='https://pilot.example.test';
      const auth=await fetch('http://127.0.0.1:4000/v1/auth/login',{
        method:'POST',headers:{'content-type':'application/json','x-citygo-client':'native',origin},
        body:JSON.stringify({email:'${email}',password:'123456'})});
      assert.equal(auth.status,200);const {token}=await auth.json();
      for(let i=0;i<2;i++)assert.equal((await fetch('http://127.0.0.1:4000/v1/admin/ai/credit/welcome',{
        method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',origin},
        body:JSON.stringify({userId:'${userId}',confirmOneTime500Rub:true})})).status,503);`);
    for (const table of [
      "payment_topup_orders",
      "ai_credit_topups",
      "payment_refunds",
      "npd_receipt_tasks",
    ])
      assert.equal(psql(`select count(*) from ${table}`), "0");
  } finally {
    assert.equal(
      psql(
        `delete from users where id=${userId} and exists(select 1 from user_credentials c where c.user_id=users.id and c.email='${email}') returning id`,
      ),
      `${userId}\nDELETE 1`,
    );
  }
}
