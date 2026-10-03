// CI-side client. The server independently validates GitHub evidence and chooses
// every path/command. No provider, database or storage credentials enter CI.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repository, selectCheckRun } from "./release-candidate.mjs";

function requireValue(value) {
  if (!value) throw new Error("deployment-preflight-rejected");
}
export async function github(path, env = process.env) {
  requireValue(typeof env.GH_TOKEN === "string" && env.GH_TOKEN.length > 0);
  const result = await fetch(
    `https://api.github.com/repos/${repository}${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  requireValue(result.ok);
  return result.json();
}
export function context(env) {
  requireValue(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_REF === "refs/heads/main" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
      ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) &&
      env.GITHUB_WORKFLOW_REF ===
        `${repository}/.github/workflows/deploy-main.yml@refs/heads/main`,
  );
  return env.GITHUB_SHA;
}
export async function waitForChecks(
  env = process.env,
  read = github,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  attempts = 80,
) {
  const sha = context(env);
  for (let attempt = 0; attempt < attempts; attempt++) {
    requireValue((await read("/git/ref/heads/main", env)).object?.sha === sha);
    let complete = true;
    for (const name of ["ci.yml", "container-smoke.yml"]) {
      const data = await read(
        `/actions/workflows/${name}/runs?head_sha=${sha}&event=push&branch=main&per_page=100`,
        env,
      );
      requireValue(
        Number.isInteger(data.total_count) &&
          data.total_count <= 100 &&
          Array.isArray(data.workflow_runs),
      );
      const matching = data.workflow_runs
        .filter(
          (run) =>
            run.head_sha === sha &&
            run.head_branch === "main" &&
            run.event === "push" &&
            run.path === `.github/workflows/${name}` &&
            run.repository?.full_name === repository,
        )
        .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
      if (!matching.length || matching[0].status !== "completed")
        complete = false;
      else selectCheckRun(data.workflow_runs, sha, name); // latest red/cancelled is final, never old green
    }
    if (complete) return;
    if (attempt + 1 < attempts) await pause(15_000);
  }
  throw new Error("checks-timeout");
}
export function deploymentRequest(env) {
  const sha = context(env);
  for (const name of [
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "CITYGO_ARTIFACT_ID",
  ])
    requireValue(/^[1-9][0-9]{0,19}$/.test(env[name] ?? ""));
  requireValue(
    typeof env.GH_TOKEN === "string" &&
      env.GH_TOKEN.length > 0 &&
      env.GH_TOKEN.length <= 4096 &&
      !/[\s\0]/.test(env.GH_TOKEN),
  );
  return {
    version: 1,
    sha,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    artifact_id: env.CITYGO_ARTIFACT_ID,
    github_token: env.GH_TOKEN,
  };
}
export function sshSettings(env) {
  // IP/DNS and user only, never URLs, options or shell fragments.
  requireValue(
    /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(env.CITYGO_DEPLOY_HOST ?? "") &&
      /^[a-z_][a-z0-9_-]{0,31}$/.test(env.CITYGO_DEPLOY_USER ?? ""),
  );
  requireValue(
    typeof env.CITYGO_DEPLOY_KNOWN_HOSTS === "string" &&
      env.CITYGO_DEPLOY_KNOWN_HOSTS.trim().length > 0 &&
      env.CITYGO_DEPLOY_KNOWN_HOSTS.length < 16384 &&
      typeof env.CITYGO_DEPLOY_SSH_KEY === "string" &&
      env.CITYGO_DEPLOY_SSH_KEY.includes("BEGIN OPENSSH PRIVATE KEY") &&
      env.CITYGO_DEPLOY_SSH_KEY.length < 16384,
  );
  return `${env.CITYGO_DEPLOY_USER}@${env.CITYGO_DEPLOY_HOST}`;
}
export async function deploy(env = process.env) {
  const request = deploymentRequest(env);
  const destination = sshSettings(env);
  requireValue(
    (await github("/git/ref/heads/main", env)).object?.sha === request.sha,
  );
  const directory = mkdtempSync(join(tmpdir(), "citygo-deploy-"));
  try {
    const key = join(directory, "identity"),
      hosts = join(directory, "known_hosts");
    writeFileSync(key, env.CITYGO_DEPLOY_SSH_KEY.trim() + "\n", {
      mode: 0o600,
    });
    writeFileSync(hosts, env.CITYGO_DEPLOY_KNOWN_HOSTS.trim() + "\n", {
      mode: 0o600,
    });
    const result = spawnSync(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-T",
        "-i",
        key,
        "-o",
        `UserKnownHostsFile=${hosts}`,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ConnectTimeout=20",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        destination,
        "deploy-main",
      ],
      {
        input: JSON.stringify(request) + "\n",
        encoding: "utf8",
        timeout: 40 * 60_000,
        maxBuffer: 64 * 1024,
        env: { PATH: env.PATH, LANG: "C.UTF-8", HOME: directory },
      },
    );
    // Controller emits only bounded, public status. Never echo SSH stderr or
    // malformed upstream output (a credential could have been pasted there).
    const lines = (result.stdout ?? "").trim().split("\n");
    for (const line of lines)
      if (/^CityGo deploy: [a-z0-9-]{1,80}$/.test(line)) console.log(line);
    requireValue(
      result.status === 0 && lines.at(-1) === `CityGo deployed: ${request.sha}`,
    );
    console.log(`CityGo deployed: ${request.sha}`);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `Deployed main commit \`${request.sha}\` after backup, migration and health checks.\n`,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true }); // freshly allocated private directory only
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    requireValue(process.argv.length === 3);
    if (process.argv[2] === "wait") await waitForChecks();
    else if (process.argv[2] === "deploy") await deploy();
    else throw new Error("unknown-command");
  } catch {
    console.error(
      "CityGo deployment stopped. Check CI, deployment configuration and the server audit log; credentials/output hidden.",
    );
    process.exitCode = 1;
  }
}
