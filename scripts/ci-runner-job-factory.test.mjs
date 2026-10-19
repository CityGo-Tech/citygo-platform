import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  admitQueuedJob,
  sameJobAdmission,
  validateJobPlan,
  JOBS,
} from "../deploy/ci/runner-job-policy.mjs";
import {
  ADAPTER_METHODS,
  runOneJob,
  factoryTick,
  runFactory,
} from "../deploy/ci/runner-job-factory.mjs";
import { openJobJournal } from "../deploy/ci/runner-job-journal.mjs";
import { renderJobWorkflow } from "../deploy/ci/render-job-workflows.mjs";

const now = "2026-10-19T12:00:00.000Z";
const op = "12345678-1234-4234-8234-123456789abc";
const gw = "98765432-1234-4234-8234-123456789abc";
const sha = "a".repeat(40);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture(kind = "ci") {
  const path = `.github/workflows/${kind === "ci" ? "ci" : "container-smoke"}.yml`;
  const spec = JOBS[path];
  const refs = Object.keys(JOBS).flatMap((x) =>
    ["refs/heads/main", "refs/pull/99/merge"].map(
      (ref) => `CityGo-Tech/citygo-platform/${x}@${ref}`,
    ),
  );
  const policy = {
    version: 1,
    repositoryId: 123,
    runnerGroupId: 9,
    runnerGroupName: "CityGo-isolated-checks",
    workflowRefs: refs,
    workflowSha256: Object.fromEntries(
      Object.keys(JOBS).map((x) => [x, "b".repeat(64)]),
    ),
  };
  const snapshot = {
    observedAt: now,
    repository: {
      id: 123,
      fullName: "CityGo-Tech/citygo-platform",
      private: true,
    },
    run: {
      id: 500,
      attempt: 1,
      workflowId: kind === "ci" ? 400 : 401,
      path,
      name: spec.workflow,
      event: "pull_request",
      headSha: sha,
      headBranch: "codex/test",
      headRepositoryId: 123,
      status: "queued",
      conclusion: null,
    },
    job: {
      id: kind === "ci" ? 600 : 601,
      runId: 500,
      attempt: 1,
      name: spec.job,
      status: "queued",
      conclusion: null,
      runnerId: 0,
      labels: [`citygo-ci-500-1-${spec.suffix}`],
    },
    source: {
      currentHeadSha: sha,
      workflowRef: `CityGo-Tech/citygo-platform/${path}@refs/pull/99/merge`,
      workflowSha256: "b".repeat(64),
    },
    group: {
      id: 9,
      name: "CityGo-isolated-checks",
      visibility: "selected",
      repositoryIds: [123],
      allowsPublicRepositories: false,
      restrictedToWorkflows: true,
      workflowRefs: refs,
    },
  };
  return { policy, snapshot };
}
function plan(kind) {
  const f = fixture(kind);
  let calls = 0;
  return admitQueuedJob(f.policy, f.snapshot, now, () => (calls++ ? gw : op));
}
function mock() {
  const p = plan();
  const calls = [],
    events = [];
  const adapter = Object.fromEntries(
    ADAPTER_METHODS.map((name) => [
      name,
      async () => {
        calls.push(name);
        // All proof field names are observed by individual test assertions below.
        return new Proxy({}, { get: () => true });
      },
    ]),
  );
  adapter.freshAdmission = async () => {
    calls.push("freshAdmission");
    return p;
  };
  adapter.runAndObserveJob = async () => {
    calls.push("runAndObserveJob");
    return {
      runId: p.runId,
      runAttempt: p.runAttempt,
      jobId: p.jobId,
      headSha: p.headSha,
      jobCount: 1,
      githubReadback: true,
      runnerName: "citygo-ci-job-" + op,
      conclusion: "success",
    };
  };
  const journal = {
    reserve: async () => {
      events.push({ stage: "reserved" });
    },
    append: async (_, event) => {
      events.push(event);
    },
  };
  return { p, adapter, journal, calls, events, clock: () => Date.parse(now) };
}

for (const kind of ["ci", "container"])
  test(`${kind}: exact queued job produces a NEW guest + gateway and fixed lease`, () => {
    const p = plan(kind);
    assert.equal(p.operationId, op);
    assert.equal(p.gatewayOperationId, gw);
    assert.notEqual(p.operationId, p.gatewayOperationId);
    assert.equal(p.jobSeconds, kind === "ci" ? 3600 : 2400);
    assert.equal(
      Date.parse(p.hardDeadline) - Date.parse(now),
      (600 + p.jobSeconds + 180) * 1000,
    );
    assert.equal(p.guestMemoryGiB, 6);
    assert.equal(validateJobPlan(p), p);
  });

const mutations = {
  "public repo": (f) => {
    f.snapshot.repository.private = false;
  },
  "foreign repo": (f) => {
    f.snapshot.repository.id++;
  },
  "fork PR": (f) => {
    f.snapshot.run.headRepositoryId++;
  },
  publisher: (f) => {
    f.snapshot.run.path = ".github/workflows/release-candidate.yml";
  },
  deploy: (f) => {
    f.snapshot.run.path = ".github/workflows/deploy-main.yml";
  },
  "prototype path": (f) => {
    f.snapshot.run.path = "__proto__";
  },
  "renamed check": (f) => {
    f.snapshot.run.name = "looks like CI";
  },
  "dispatch event": (f) => {
    f.snapshot.run.event = "workflow_dispatch";
  },
  "PR target": (f) => {
    f.snapshot.run.event = "pull_request_target";
  },
  "push other branch": (f) => {
    f.snapshot.run.event = "push";
  },
  "cancelled run": (f) => {
    f.snapshot.run.status = "completed";
    f.snapshot.run.conclusion = "cancelled";
  },
  "finished job": (f) => {
    f.snapshot.job.status = "completed";
  },
  "busy job": (f) => {
    f.snapshot.job.status = "in_progress";
    f.snapshot.job.runnerId = 14;
  },
  "old run attempt": (f) => {
    f.snapshot.job.attempt++;
  },
  "other run": (f) => {
    f.snapshot.job.runId++;
  },
  "extra labels": (f) => {
    f.snapshot.job.labels.push("self-hosted");
  },
  "guessable label alone": (f) => {
    f.snapshot.group.restrictedToWorkflows = false;
  },
  "duplicate labels": (f) => {
    f.snapshot.job.labels.push(f.snapshot.job.labels[0]);
  },
  "old SHA": (f) => {
    f.snapshot.source.currentHeadSha = "c".repeat(40);
  },
  "workflow modified": (f) => {
    f.snapshot.source.workflowSha256 = "c".repeat(64);
  },
  "unapproved ref": (f) => {
    f.snapshot.source.workflowRef = f.snapshot.source.workflowRef.replace(
      "99",
      "100",
    );
  },
  "default group": (f) => {
    f.snapshot.group.id = 1;
  },
  "all workflows": (f) => {
    f.snapshot.group.workflowRefs = [];
  },
  "extra workflow": (f) => {
    f.snapshot.group.workflowRefs = [
      ...f.snapshot.group.workflowRefs,
      "CityGo-Tech/other/.github/workflows/ci.yml@main",
    ];
  },
  "public group": (f) => {
    f.snapshot.group.allowsPublicRepositories = true;
  },
  "all repos": (f) => {
    f.snapshot.group.visibility = "all";
  },
  "extra repo": (f) => {
    f.snapshot.group.repositoryIds.push(124);
  },
  "stale snapshot": (f) => {
    f.snapshot.observedAt = "2026-10-19T11:59:29.999Z";
  },
  "future snapshot": (f) => {
    f.snapshot.observedAt = "2026-10-19T12:00:00.001Z";
  },
  "bad calendar": (f) => {
    f.snapshot.observedAt = "2026-02-30T12:00:00.000Z";
  },
  "extra token": (f) => {
    f.snapshot.token = "NEVER_PERSIST";
  },
  "unbounded IDs": (f) => {
    f.snapshot.job.id = Number.MAX_SAFE_INTEGER + 1;
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`admission refuses ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => admitQueuedJob(f.policy, f.snapshot, now),
      /^Error: ci_factory_/,
    );
  });

test("main push allowed only at exact main SHA, a fresh recheck cannot swap jobs", () => {
  const f = fixture();
  f.snapshot.run.event = "push";
  f.snapshot.run.headBranch = "main";
  f.snapshot.source.workflowRef = f.snapshot.source.workflowRef.replace(
    "refs/pull/99/merge",
    "refs/heads/main",
  );
  const p = admitQueuedJob(f.policy, f.snapshot, now);
  assert.equal(
    sameJobAdmission(p, { ...p, createdAt: "2026-10-19T12:01:00.000Z" }),
    true,
  );
  for (const field of [
    "jobId",
    "runAttempt",
    "headSha",
    "runnerGroupId",
    "workflowSha256",
    "label",
  ])
    assert.throws(
      () => sameJobAdmission(p, { ...p, [field]: "changed" }),
      /admission_changed/,
    );
  assert.throws(
    () => admitQueuedJob(f.policy, f.snapshot, now, () => op),
    /operation_invalid/,
  );
});

test("one job success is accepted only AFTER external cleanup; all proof stages and admission order enforced", async () => {
  const m = mock();
  const result = await runOneJob(m.p, m.adapter, m.journal, m.clock);
  assert.equal(result.stage, "job_and_cleanup_verified");
  assert.equal(result.githubCheckWritten, false);
  assert.equal(m.calls.filter((x) => x === "freshAdmission").length, 3);
  assert.ok(
    m.calls.indexOf("armIndependentWatchdogs") <
      m.calls.indexOf("bootAndVerifyNetwork"),
  );
  assert.ok(
    m.calls.indexOf("removeRegistrationMaterial") <
      m.calls.indexOf("detachPublicSeed"),
  );
  assert.ok(
    m.calls.indexOf("detachPublicSeed") < m.calls.indexOf("runAndObserveJob"),
  );
  assert.deepEqual(m.calls.slice(-5), [
    "closeOwnedNetwork",
    "destroyOwnedClient",
    "destroyOwnedGateway",
    "removeOwnedRegistration",
    "removeFinishedWatchdogs",
  ]);
  assert.equal(m.events.at(-1).stage, "cleanup_verified");
});

for (const phase of ADAPTER_METHODS.filter(
  (x) => !["assertTrustedInstallation", "freshAdmission"].includes(x),
)) {
  test(`failure at ${phase}: no dispatch retry, no raw exception and no guest/disk reuse`, async () => {
    const m = mock();
    m.adapter[phase] = async () => {
      m.calls.push(phase);
      throw new Error("SECRET_TOKEN_FROM_BAD_ADAPTER");
    };
    const result = await runOneJob(m.p, m.adapter, m.journal, m.clock);
    assert.notEqual(result.stage, "job_and_cleanup_verified");
    assert.equal(JSON.stringify(m.events).includes("SECRET"), false);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(m.calls.filter((x) => x === phase).length, 1);
    const cleanup = [
      "closeOwnedNetwork",
      "destroyOwnedClient",
      "destroyOwnedGateway",
      "removeOwnedRegistration",
      "removeFinishedWatchdogs",
    ];
    if (cleanup.includes(phase)) {
      assert.equal(result.stage, "quarantined");
      assert.equal(result.nextJobAllowed, false);
      assert.equal(
        m.calls.includes(cleanup[cleanup.indexOf(phase) + 1]),
        false,
      );
    } else assert.equal(result.nextJobAllowed, true);
  });
}

for (const phase of [
  "createClient",
  "armIndependentWatchdogs",
  "bootAndVerifyNetwork",
  "prepareAndVerifyToolchain",
  "registerOneJobRunner",
  "removeRegistrationMaterial",
  "detachPublicSeed",
]) {
  test(`false/missing ${phase} proof refuses listener`, async () => {
    const m = mock();
    m.adapter[phase] = async () => ({});
    const result = await runOneJob(m.p, m.adapter, m.journal, m.clock);
    assert.equal(result.stage, "failed_preserved");
    assert.equal(m.calls.includes("runAndObserveJob"), false);
  });
}

test("cancellation, UTC rollback and suspended-host deadline stop work but still reconcile resources", async () => {
  for (const fault of ["cancel", "rollback", "deadline"]) {
    const m = mock(),
      abort = new AbortController();
    let tick = Date.parse(now);
    m.adapter.createClient = async () => {
      m.calls.push("createClient");
      if (fault === "cancel") abort.abort();
      else
        tick = fault === "rollback" ? tick - 1 : Date.parse(m.p.hardDeadline);
      return new Proxy({}, { get: () => true });
    };
    const result = await runOneJob(
      m.p,
      m.adapter,
      m.journal,
      () => tick,
      abort.signal,
    );
    assert.equal(result.stage, "failed_preserved");
    assert.equal(m.calls.includes("runAndObserveJob"), false);
    assert.ok(m.calls.includes("destroyOwnedClient"));
  }
});

test("source/group recheck after boot prevents registration; reservation before mutation is durable", async () => {
  const m = mock();
  let read = 0;
  m.adapter.freshAdmission = async () =>
    ++read === 1 ? m.p : { ...m.p, headSha: "d".repeat(40) };
  const result = await runOneJob(m.p, m.adapter, m.journal, m.clock);
  assert.equal(result.stage, "failed_preserved");
  assert.equal(m.calls.includes("registerOneJobRunner"), false);
  assert.equal(m.events[0].stage, "reserved");
  assert.equal(m.events[1].stage, "resource_mutation_intent");
  const n = mock();
  n.journal.append = async () => {
    throw Error("disk full");
  };
  await runOneJob(n.p, n.adapter, n.journal, n.clock);
  assert.equal(n.calls.includes("createGateway"), false);
});

test("a guest-claimed success or a different GitHub job cannot create a green check", async () => {
  for (const mutation of [
    { jobCount: 2 },
    { githubReadback: false },
    { jobId: 999 },
    { headSha: "d".repeat(40) },
    { runAttempt: 2 },
    { runnerName: "other" },
    { conclusion: "skipped" },
  ]) {
    const m = mock(),
      original = m.adapter.runAndObserveJob;
    m.adapter.runAndObserveJob = async () => ({
      ...(await original()),
      ...mutation,
    });
    const result = await runOneJob(m.p, m.adapter, m.journal, m.clock);
    assert.equal(result.stage, "failed_preserved");
    assert.equal(result.githubCheckWritten, false);
  }
  const m = mock(),
    original = m.adapter.runAndObserveJob;
  m.adapter.runAndObserveJob = async () => ({
    ...(await original()),
    conclusion: "failure",
  });
  const result = await runOneJob(m.p, m.adapter, m.journal, m.clock);
  assert.equal(result.stage, "job_and_cleanup_verified");
  assert.equal(result.conclusion, "failure");
});

test("single host slot: unreconciled or quarantined resources retain lock, no second job starts", async () => {
  for (const state of ["ready", "orphan", "cleanup_failed"]) {
    const m = mock();
    let released = 0,
      reconciled = false;
    const host = {
      lockHost: async () => ({
        release: async () => {
          released++;
        },
      }),
      reconcile: async () => {
        reconciled = true;
        return {
          noUnreconciledResources: state !== "orphan",
          noActiveJob: true,
        };
      },
      queuedPlans: async () => {
        assert.equal(reconciled, true);
        return [m.p, plan("container")];
      },
      installation: async () => m.adapter,
      journal: async () => m.journal,
      clock: m.clock,
    };
    if (state === "cleanup_failed")
      m.adapter.destroyOwnedClient = async () => ({});
    if (state === "orphan")
      await assert.rejects(factoryTick(host), /orphan_cleanup_required/);
    else await factoryTick(host);
    assert.equal(
      m.calls.filter((x) => x === "runAndObserveJob").length,
      state === "orphan" ? 0 : 1,
    );
    assert.equal(released, state === "ready" ? 1 : 0);
  }
});

test("real journal: exclusive job reservation, concurrent append collision, chain tamper, terminal and data allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "citygo-ci-journal-"));
  try {
    const guardCalls = [],
      guard = async (path) => {
        guardCalls.push(path);
      };
    const journal = await openJobJournal(root, guard);
    const p = plan();
    const both = await Promise.allSettled([
      journal.reserve(p),
      journal.reserve(p),
    ]);
    assert.equal(both.filter((x) => x.status === "fulfilled").length, 1);
    await assert.rejects(
      journal.append(p.jobKey, {
        stage: "failed_preserved",
        rawError: "SECRET",
      }),
      /event_invalid/,
    );
    const attempts = await Promise.allSettled([
      journal.append(p.jobKey, { stage: "resource_mutation_intent" }),
      journal.append(p.jobKey, { stage: "resource_mutation_intent" }),
    ]);
    // One may observe the other's committed event, or collide on CreateNew.
    assert.ok(attempts.some((x) => x.status === "fulfilled"));
    await journal.append(p.jobKey, { stage: "cleanup_verified" });
    const proof = await journal.read(p.jobKey);
    assert.equal(proof.entries.at(-1).event.stage, "cleanup_verified");
    await assert.rejects(
      journal.append(p.jobKey, { stage: "cleanup_intent" }),
      /terminal/,
    );
    assert.ok(guardCalls.length >= 5);
    const file = join(root, p.jobKey, "0000.json");
    const entry = JSON.parse(await readFile(file, "utf8"));
    entry.previous = "c".repeat(64);
    await writeFile(file, JSON.stringify(entry) + "\n");
    await assert.rejects(journal.read(p.jobKey), /chain_invalid/);
    await assert.rejects(journal.read("../escape"), /job_key_invalid/);
    await assert.rejects(
      journal.reserve({ ...p, token: "SECRET" }),
      /shape_invalid/,
    );
    await assert.rejects(openJobJournal(root), /trust_guard_required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal rejects partial reservations, malformed/noncanonical records and symlinked paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "citygo-ci-journal-fault-"));
  try {
    const journal = await openJobJournal(root, async () => {}),
      p = plan();
    await mkdir(join(root, p.jobKey));
    await assert.rejects(journal.reserve(p), /EEXIST/);
    await assert.rejects(
      journal.append(p.jobKey, { stage: "cleanup_intent" }),
      /entries_invalid/,
    );
    await writeFile(
      join(root, p.jobKey, "plan.json"),
      JSON.stringify(p) + " \n",
    );
    await assert.rejects(journal.read(p.jobKey), /noncanonical/);
    const link = join(root, "link");
    await symlink(
      join(root, p.jobKey),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      openJobJournal(link, async () => {}),
      /plain_path_required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow preview changes only runner route, finite CI timeout and checkout credential persistence", () => {
  for (const kind of ["ci", "container"]) {
    const file = kind === "ci" ? "ci.yml" : "container-smoke.yml";
    const source = readFileSync(
      new URL("../.github/workflows/" + file, import.meta.url),
      "utf8",
    );
    const preview = renderJobWorkflow(source, kind, hash(source));
    assert.ok(preview.includes("group: CityGo-isolated-checks"));
    assert.ok(
      preview.includes("${{ github.run_id }}-${{ github.run_attempt }}-"),
    );
    assert.equal(preview.includes("continue-on-error"), false);
    let reverse = preview.replace(
      /[ ]{4}runs-on:\n[ ]{6}group: CityGo-isolated-checks\n[ ]{6}labels: [^\n]+\n/,
      "    runs-on: ubuntu-latest\n",
    );
    if (kind === "ci")
      reverse = reverse
        .replace("    timeout-minutes: 60\n", "")
        .replace(
          "      - uses: actions/checkout@v7\n        with:\n          persist-credentials: false\n",
          "      - uses: actions/checkout@v7\n",
        );
    assert.equal(reverse, source.replaceAll("\r\n", "\n"));
    assert.throws(
      () => renderJobWorkflow(source, kind, "0".repeat(64)),
      /source_pin/,
    );
  }
  for (const file of ["deploy-main.yml", "release-candidate.yml"]) {
    const source = readFileSync(
      new URL("../.github/workflows/" + file, import.meta.url),
      "utf8",
    );
    assert.throws(
      () => renderJobWorkflow(source, "ci", hash(source)),
      /structure_changed/,
    );
    assert.match(source, /runs-on: ubuntu-latest/);
  }
});

test("PowerShell guest preparation has plan-only default, pinned archive and operation-bound apply", () => {
  const file = new URL(
    "../deploy/ci/prepare-job-toolchain.py",
    import.meta.url,
  );
  const source = readFileSync(file, "utf8");
  assert.match(
    source,
    /6896f9e3a6b0a354bf470835a96da76d2f801cd50dcf047ad7c4563bf93bf431/,
  );
  assert.match(source, /O_EXCL/);
  assert.match(source, /filter="data"/);
  assert.match(source, /PREPARE_DISPOSABLE_CI:/);
  assert.match(source, /cloud-init/);
  const code =
    "import importlib.util,sys\ns=importlib.util.spec_from_file_location('tools',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nassert m.main(['--plan']) == 0\nassert m.main(['--apply']) == 2\nassert m.main(['--apply','--verified-public-archive','/tmp/evil']) == 2\n";
  const done = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-B", "-c", code, fileURLToPath(file)],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(done.status, 0, done.stderr);
});

test("automatic service uses one host slot, awaits each tick, stops on abort, and never retries quarantine", async () => {
  const abort = new AbortController();
  let polls = 0,
    released = 0,
    waited = 0;
  const host = {
    lockHost: async () => ({
      release: async () => {
        released++;
      },
    }),
    reconcile: async () => ({
      noUnreconciledResources: true,
      noActiveJob: true,
    }),
    queuedPlans: async () => {
      polls++;
      return [];
    },
    installation: async () => {
      throw Error("not needed for idle");
    },
    journal: async () => {
      throw Error("not needed for idle");
    },
    clock: () => Date.parse(now),
  };
  const result = await runFactory(host, {
    signal: abort.signal,
    wait: async (ms, signal) => {
      assert.equal(ms, 20000);
      assert.equal(signal, abort.signal);
      waited++;
      if (waited === 2) abort.abort();
    },
  });
  assert.deepEqual(result, { stage: "stopped", ticks: 2 });
  assert.equal(polls, 2);
  assert.equal(released, 2);
  await assert.rejects(
    runFactory(host, {
      signal: abort.signal,
      wait: async () => {},
      intervalMs: 1,
    }),
    /options_invalid/,
  );
});

test("missing installed-adapter acceptance blocks resource creation, with no unsafe native fallback", async () => {
  const m = mock();
  m.adapter.assertTrustedInstallation = async () => ({});
  const result = await runOneJob(m.p, m.adapter, m.journal, m.clock);
  assert.equal(result.code, "ci_factory_host_installation_not_verified");
  assert.equal(m.calls.includes("createGateway"), false);
  assert.equal(m.events.length, 0);
});

test("policy rejects executable object shapes without invoking getters", () => {
  const f = fixture();
  let called = false;
  Object.defineProperty(f.snapshot.run, "headSha", {
    enumerable: true,
    get() {
      called = true;
      throw Error("do not call");
    },
  });
  assert.throws(
    () => admitQueuedJob(f.policy, f.snapshot, now),
    /shape_invalid/,
  );
  assert.equal(called, false);
  assert.throws(
    () => admitQueuedJob(new Proxy(f.policy, {}), f.snapshot, now),
    /shape_invalid/,
  );
});

test("global journal operation reservations reject VM/disk identity reuse across different jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "citygo-ci-journal-identities-"));
  try {
    const journal = await openJobJournal(root, async () => {});
    const first = plan(),
      second = plan("container");
    await journal.reserve(first);
    await assert.rejects(journal.reserve(second), /EEXIST/);
    await assert.rejects(journal.read(second.jobKey), /entries_invalid/);
    const path = join(root, "operation-" + op + ".json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, jobKey: second.jobKey, role: "client" }) +
        "\n",
    );
    await assert.rejects(
      journal.read(first.jobKey),
      /operation_binding_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
