import assert from "node:assert/strict";
import { test } from "node:test";
import {
  controllerFixtureEnv,
  localDockerEndpoint,
  runControllerSmoke,
} from "./web-switch-controller-smoke.mjs";

test("durable V2 has an inert same-image plan and still requires the explicit fixture permission", async () => {
  const output = [];
  const previous = console.log;
  console.log = (value) => output.push(value);
  try {
    await runControllerSmoke(["--plan", "--durable-v2"]);
  } finally {
    console.log = previous;
  }
  const plan = JSON.parse(output[0]);
  assert.equal(plan.controllerPlanVersion, 2);
  assert.equal(plan.sameWebBootstrap, true);
  assert.equal(plan.syntheticDistinctWebReleases, false);
  await assert.rejects(
    runControllerSmoke(["--disposable", "--durable-v2"]),
    /Explicit disposable privileged fixture flag required/,
  );
});

test("fixture Docker children cannot inherit credentials, remote daemon or altered trust", () => {
  const env = controllerFixtureEnv({
    PATH: "/usr/bin",
    HOME: "/fixture",
    SystemRoot: "C:\\Windows",
    OPENAI_API_KEY: "private",
    ROUTERAI_API_KEY: "private",
    AWS_SECRET_ACCESS_KEY: "private",
    TEST_DATABASE_URL: "private",
    DOCKER_HOST: "ssh://production",
    DOCKER_CONTEXT: "production",
    DOCKER_CONFIG: "/private",
    SSL_CERT_FILE: "/private/ca",
    LD_LIBRARY_PATH: "/private",
    NODE_OPTIONS: "--require private",
    CITYGO_AD_PIXELS_E2E_ENABLED: "enabled",
    HTTPS_PROXY: "https://private",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/fixture");
  assert.ok(!JSON.stringify(env).includes("private"));
  assert.ok(
    !Object.keys(env).some((key) =>
      /DOCKER|SECRET|API_KEY|DATABASE|SSL_CERT|PROXY|PIXEL/.test(key),
    ),
  );
});
test("local context guard accepts real local sockets and rejects stored remote contexts", () => {
  const context = (Host) => ({ Endpoints: { docker: { Host } } });
  for (const endpoint of [
    "unix:///var/run/docker.sock",
    "unix:///home/user/.docker/desktop/docker.sock",
    "npipe:////./pipe/dockerDesktopLinuxEngine",
  ]) {
    assert.equal(localDockerEndpoint(context(endpoint)), endpoint);
  }
  for (const endpoint of [
    "ssh://production",
    "tcp://127.0.0.1:2375",
    "https://remote",
    "npipe:////remote/pipe/docker",
    "unix://remote/docker.sock",
    "unix:///tmp/a\u0000socket",
    "unix:///tmp/a\nsocket",
    undefined,
  ]) {
    assert.throws(() => localDockerEndpoint(context(endpoint)));
  }
});
