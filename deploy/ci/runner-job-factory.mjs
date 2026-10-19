// Trusted HOST orchestration. No GitHub or Hyper-V side effects at import.
// The native adapter must be installed independently from a reviewed, pinned
// host bundle; it may NOT resolve scripts from the repository being tested.
import {
  requireCi,
  validateJobPlan,
  sameJobAdmission,
} from "./runner-job-policy.mjs";

export const ADAPTER_METHODS = Object.freeze([
  "assertTrustedInstallation",
  "freshAdmission",
  "createGateway",
  "createClient",
  "armIndependentWatchdogs",
  "bootAndVerifyNetwork",
  "prepareAndVerifyToolchain",
  "registerOneJobRunner",
  "removeRegistrationMaterial",
  "detachPublicSeed",
  "runAndObserveJob",
  "closeOwnedNetwork",
  "destroyOwnedClient",
  "destroyOwnedGateway",
  "removeOwnedRegistration",
  "removeFinishedWatchdogs",
]);
export const JOURNAL_METHODS = Object.freeze(["reserve", "append"]);
function methods(value, names) {
  requireCi(
    value && names.every((name) => typeof value[name] === "function"),
    "adapter_incomplete",
  );
}
function proof(value, fields, code) {
  requireCi(value && fields.every((key) => value[key] === true), code);
}
function failureCode(error) {
  return error instanceof Error &&
    /^ci_factory_[a-z_]{1,64}$/.test(error.message)
    ? error.message
    : "ci_factory_adapter_failed";
}

// One call = one immutable job reservation and two NEW VM identities. A failure
// does not release that reservation. Rerun via GitHub's new attempt, not by
// deleting journals, reusing disks, stealing a stale lock or retrying dispatch.
export async function runOneJob(plan, adapter, journal, clock, signal) {
  validateJobPlan(plan);
  methods(adapter, ADAPTER_METHODS);
  methods(journal, JOURNAL_METHODS);
  requireCi(typeof clock === "function", "clock_required");
  let phase = "reserve",
    result = null,
    failed = null,
    cleanupError = null;
  let reserved = false,
    mutationIntent = false,
    lastTime = Date.parse(plan.createdAt);
  const deadline = Date.parse(plan.hardDeadline);
  async function event(stage, details = {}) {
    await journal.append(plan.jobKey, { stage, ...details });
  }
  function live() {
    const now = clock();
    requireCi(Number.isFinite(now) && now >= lastTime, "clock_rollback");
    lastTime = now;
    requireCi(now < deadline - plan.cleanupSeconds * 1000, "lease_expired");
    requireCi(!signal?.aborted, "cancelled");
  }
  async function step(name, required) {
    phase = name;
    live();
    await event(name + "_intent");
    const observed = await adapter[name](plan, signal);
    live();
    proof(observed, required, name + "_not_verified");
    await event(name + "_verified");
    return observed;
  }
  try {
    // Host ACL/locks/pins, no secrets in the guest bundle, native adapter
    // accepted, both guest/toolchain leases supported: no mock auto-fallback.
    proof(
      await adapter.assertTrustedInstallation(plan),
      [
        "hostBundlePinned",
        "hostPrivateAcl",
        "isolatedBaseAccepted",
        "jobLeaseSupported",
        "runnerGroupsApiAuthorized",
      ],
      "host_installation_not_verified",
    );
    live();
    await journal.reserve(plan);
    reserved = true;
    phase = "initial_admission";
    sameJobAdmission(plan, await adapter.freshAdmission(plan));
    // Durable intent precedes even a potentially ambiguous first Create-VM.
    // Cleanup must reconcile by owned operation IDs even if no return arrived.
    await event("resource_mutation_intent");
    mutationIntent = true;
    await step("createGateway", ["newOffDisconnectedGateway", "baseUnchanged"]);
    await step("createClient", [
      "newOffDisconnectedClient",
      "baseUnchanged",
      "standaloneDisk",
    ]);
    await step("armIndependentWatchdogs", [
      "clientArmed",
      "gatewayArmed",
      "beforeBoot",
      "absoluteLeaseBound",
    ]);
    await step("bootAndVerifyNetwork", [
      "privateSwitchOnly",
      "hostDenied",
      "serverDenied",
      "l2Witness",
      "bothFamiliesGuarded",
      "networkFingerprintStable",
    ]);
    await step("prepareAndVerifyToolchain", [
      "node24",
      "pnpm1015",
      "python312",
      "pwsh",
      "nativeDocker",
      "compose",
      "buildx",
      "sudo",
      "git",
      "age",
    ]);
    phase = "pre_registration_admission";
    live();
    sameJobAdmission(plan, await adapter.freshAdmission(plan));
    await step("registerOneJobRunner", [
      "groupAccessReadback",
      "operationBound",
      "ephemeral",
      "disableUpdate",
      "exactLabel",
      "linuxGuest",
    ]);
    await step("removeRegistrationMaterial", [
      "kvpAbsent",
      "noManagementCredentialInGuest",
    ]);
    await step("detachPublicSeed", ["dvdEmpty", "seedNotMounted"]);
    phase = "pre_listener_admission";
    live();
    sameJobAdmission(plan, await adapter.freshAdmission(plan));
    phase = "runAndObserveJob";
    await event("listen_one_job_intent");
    result = await adapter.runAndObserveJob(plan, signal);
    live();
    requireCi(
      result?.runId === plan.runId &&
        result?.runAttempt === plan.runAttempt &&
        result?.jobId === plan.jobId &&
        result?.headSha === plan.headSha &&
        result?.jobCount === 1 &&
        result?.githubReadback === true &&
        result?.runnerName === "citygo-ci-job-" + plan.operationId &&
        [
          "success",
          "failure",
          "cancelled",
          "timed_out",
          "action_required",
        ].includes(result?.conclusion),
      "github_job_readback_mismatch",
    );
    await event("github_job_completed", { conclusion: result.conclusion });
  } catch (error) {
    failed = failureCode(error);
    if (reserved) {
      try {
        await event("failed_preserved", { phase, code: failed });
      } catch {
        failed = "ci_factory_journal_failed";
      }
    }
  } finally {
    if (mutationIntent) {
      // Independent watchdog remains responsible if this process dies. Never
      // pass a cancelled signal to cleanup and never retry ambiguous native
      // mutations here. Adapter must close networking before any disk removal.
      try {
        await event("cleanup_intent");
        proof(
          await adapter.closeOwnedNetwork(plan),
          ["clientDisconnected", "gatewayForwardingClosed"],
          "network_close_not_verified",
        );
        proof(
          await adapter.destroyOwnedClient(plan),
          ["vmAbsent", "diskAbsent", "offBeforeDelete"],
          "client_cleanup_not_verified",
        );
        proof(
          await adapter.destroyOwnedGateway(plan),
          ["vmAbsent", "diskAbsent", "offBeforeDelete"],
          "gateway_cleanup_not_verified",
        );
        proof(
          await adapter.removeOwnedRegistration(plan),
          ["runnerAbsent"],
          "registration_cleanup_not_verified",
        );
        proof(
          await adapter.removeFinishedWatchdogs(plan),
          ["tasksAbsent", "independentReadback"],
          "watchdog_cleanup_not_verified",
        );
        await event("cleanup_verified");
      } catch (error) {
        cleanupError = failureCode(error);
        try {
          await event("quarantined", { code: cleanupError });
        } catch {
          /* retain external watchers + lock */
        }
      }
    }
  }
  // No GitHub status write: only GitHub's own job can report a check success.
  return Object.freeze({
    stage: cleanupError
      ? "quarantined"
      : failed
        ? "failed_preserved"
        : "job_and_cleanup_verified",
    jobKey: plan.jobKey,
    code: cleanupError ?? failed,
    conclusion: result?.conclusion ?? null,
    nextJobAllowed: !cleanupError,
    githubCheckWritten: false,
  });
}

// Automatic queue loop's bounded single-tick core. The host service owns the
// exclusive machine lease for the entire tick. It never queues two 6 GiB guests
// onto this host and refuses new work until all orphan evidence reconciles.
export async function factoryTick(host, signal) {
  methods(host, [
    "lockHost",
    "reconcile",
    "queuedPlans",
    "installation",
    "journal",
    "clock",
  ]);
  const lock = await host.lockHost();
  requireCi(lock && typeof lock.release === "function", "host_lock_invalid");
  let release = true;
  try {
    proof(
      await host.reconcile(),
      ["noUnreconciledResources", "noActiveJob"],
      "orphan_cleanup_required",
    );
    const plans = await host.queuedPlans();
    requireCi(Array.isArray(plans) && plans.length <= 100, "queue_unbounded");
    if (!plans.length || signal?.aborted)
      return { stage: "idle", nextJobAllowed: true };
    const result = await runOneJob(
      plans[0],
      await host.installation(),
      await host.journal(),
      host.clock,
      signal,
    );
    release = result.nextJobAllowed;
    return result;
  } catch (error) {
    // Unknown state is not an idle host. Do not permit another scheduler to
    // steal a stale lease; explicit exact-owned reconciliation is required.
    release = false;
    throw new Error(failureCode(error));
  } finally {
    if (release) await lock.release();
  }
}

// Service loop, deliberately not auto-started on import. A separately installed
// trusted host entrypoint must supply the native adapter and exclusive lease.
// No lock stealing, hidden job retries, detached promises or hosted fallback.
export async function runFactory(host, { signal, wait, intervalMs = 20000 }) {
  requireCi(
    signal &&
      typeof signal.aborted === "boolean" &&
      typeof wait === "function" &&
      Number.isSafeInteger(intervalMs) &&
      intervalMs >= 20000 &&
      intervalMs <= 60000,
    "service_options_invalid",
  );
  let ticks = 0;
  while (!signal.aborted) {
    const result = await factoryTick(host, signal);
    ticks++;
    if (!result.nextJobAllowed) return { stage: "quarantined", ticks };
    if (!signal.aborted) await wait(intervalMs, signal);
  }
  return { stage: "stopped", ticks };
}
