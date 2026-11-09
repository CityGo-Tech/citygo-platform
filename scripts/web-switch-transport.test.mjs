import assert from "node:assert/strict";
import test from "node:test";
import { classifyProbeFailures } from "./web-switch-transport.mjs";
import { assessIdleReuseControl } from "./web-switch-smoke.mjs";

const timeline = [
  { phase: "nginx-hup-requested", monotonic: 100 },
  { phase: "nginx-hup-returned", monotonic: 180 },
  { phase: "green-confirmed-old-generation-active", monotonic: 250 },
];
function reset() {
  return {
    kind: "keepalive",
    code: "ECONNRESET",
    admittedToFixtureApi: false,
    trace: {
      method: "GET",
      path: "/api/rehearsal/probe",
      reusedSocket: true,
      code: "ECONNRESET",
      responseHeadersAt: null,
      responseBytes: 0,
      startedMonotonic: 175,
      finishedMonotonic: 179,
      requestFlushedAt: null,
      requestBytesWritten: 0,
      phaseAtStart: "nginx-hup-requested",
      phaseAtFinish: "later-callback-phase",
    },
  };
}
test("identifies an unadmitted reused idle GET using request times, not callback phase", () => {
  const failure = reset();
  const result = classifyProbeFailures([failure], timeline);
  assert.deepEqual(result.idleReuseResets, [failure]);
  assert.deepEqual(result.unexpectedFailures, []);
  // Locally flushed bytes do not prove API admission: deterministic Nginx
  // control reproduced this variant as well, without a second request.
  failure.trace.requestFlushedAt = 123;
  failure.trace.requestBytesWritten = 247;
  assert.equal(
    classifyProbeFailures([failure], timeline).idleReuseResets.length,
    1,
  );
});
test("never accepts POST, SSE, unknown admission, fresh sockets or other transport errors", () => {
  const mutations = [
    (f) => {
      f.trace.method = "POST";
    },
    (f) => {
      f.trace.path = "/api/rehearsal/messages";
    },
    (f) => {
      f.admittedToFixtureApi = undefined;
    },
    (f) => {
      f.admittedToFixtureApi = true;
    },
    (f) => {
      f.kind = "fresh";
    },
    (f) => {
      f.trace.reusedSocket = false;
    },
    (f) => {
      f.code = "ETIMEDOUT";
    },
    (f) => {
      f.trace.responseHeadersAt = 176;
    },
    (f) => {
      f.trace.responseBytes = 1;
    },
  ];
  for (const mutate of mutations) {
    const failure = reset();
    mutate(failure);
    const result = classifyProbeFailures([failure], timeline);
    assert.deepEqual(result.idleReuseResets, []);
    assert.deepEqual(result.unexpectedFailures, [failure]);
  }
});
test("fails closed outside the observed HUP interval even when a phase label says HUP", () => {
  for (const [start, finish] of [
    [99, 101],
    [249, 251],
    [177, 176],
    [NaN, 180],
  ]) {
    const failure = reset();
    failure.trace.startedMonotonic = start;
    failure.trace.finishedMonotonic = finish;
    assert.equal(
      classifyProbeFailures([failure], timeline).unexpectedFailures.length,
      1,
    );
  }
  assert.equal(
    classifyProbeFailures([reset()], []).unexpectedFailures.length,
    1,
  );
});
test("reports every real failure and retains every expected closure without retrying", () => {
  const idle = reset(),
    fresh = reset(),
    admitted = reset(),
    unknown = reset();
  fresh.kind = "fresh";
  admitted.admittedToFixtureApi = true;
  delete unknown.admittedToFixtureApi;
  const result = classifyProbeFailures(
    [idle, fresh, admitted, unknown],
    timeline,
  );
  assert.deepEqual(result.idleReuseResets, [idle]);
  assert.deepEqual(result.unexpectedFailures, [fresh, admitted, unknown]);
  assert.deepEqual(result.freshFailures, [fresh]);
  assert.deepEqual(result.admittedFailures, [admitted]);
  assert.deepEqual(result.otherFailures, [unknown]);
});

function idleControlEvidence(legacy = false) {
  const trace = {
    id: "single-control-request",
    method: "GET",
    path: "/api/rehearsal/probe",
    kind: "forced-idle-reuse",
    localPort: legacy ? 49062 : 49074,
    remotePort: 32769,
    startedMonotonic: 2300,
    reusedSocket: legacy,
    responseHeadersAt: legacy ? null : 2500,
    responseBytes: legacy ? 0 : 29,
    ...(legacy ? { code: "ECONNRESET" } : { status: 200 }),
  };
  const primed = {
    localPort: 49062,
    remotePort: 32769,
    destroyed: false,
    writable: true,
    readable: true,
    pendingReadCheckSupported: !legacy,
    pendingRead: legacy ? null : false,
  };
  return {
    minimumKeepaliveSeconds: 0,
    prime: {
      id: "prime-request",
      status: 200,
      reusedSocket: false,
      localPort: 49062,
      remotePort: 32769,
      finishedMonotonic: 1000,
    },
    beforeHup: { ...primed },
    beforeReuse: { ...primed, pendingRead: legacy ? null : true },
    afterAttempt: { destroyed: true },
    sameSocket: legacy,
    trace,
    outcome: legacy
      ? { status: "rejected", errorCode: "ECONNRESET" }
      : {
          status: "fulfilled",
          responseStatus: 200,
          responseBody: '{"userId":"synthetic-user-1"}',
        },
    admission: legacy
      ? null
      : {
          id: trace.id,
          method: "GET",
          path: "/rehearsal/probe",
          visits: 1,
          responseFinishedAt: 2450,
        },
    httpAttempts: 1,
  };
}

test("single idle control distinguishes legacy reset from pre-send socket avoidance", () => {
  const legacy = assessIdleReuseControl(idleControlEvidence(true));
  assert.equal(legacy.classification, "legacy-stale-idle-reset");
  assert.equal(legacy.legacyResetReproduced, true);
  assert.equal(legacy.protectedClientAvoidanceObserved, false);
  assert.equal(legacy.expectedApiAdmissions, 0);
  const protectedClient = assessIdleReuseControl(idleControlEvidence());
  assert.equal(
    protectedClient.classification,
    "client-discarded-stale-idle-before-send",
  );
  assert.equal(protectedClient.legacyResetReproduced, false);
  assert.equal(protectedClient.protectedClientAvoidanceObserved, true);
  assert.equal(protectedClient.expectedApiAdmissions, 1);
});

test("fresh positive control requires stale identity, destruction, one response and matching API admission", () => {
  for (const mutate of [
    (e) => {
      e.afterAttempt.destroyed = false;
    },
    (e) => {
      e.sameSocket = true;
    },
    (e) => {
      e.trace.localPort = e.prime.localPort;
    },
    (e) => {
      e.beforeHup.localPort++;
    },
    (e) => {
      e.beforeHup.pendingRead = true;
    },
    (e) => {
      e.beforeHup.pendingReadCheckSupported = false;
      e.beforeHup.pendingRead = null;
    },
    (e) => {
      e.beforeReuse.destroyed = true;
    },
    (e) => {
      e.beforeReuse.pendingReadCheckSupported = false;
    },
    (e) => {
      e.beforeReuse.pendingRead = false;
    },
    (e) => {
      e.trace.reusedSocket = true;
    },
    (e) => {
      e.trace.method = "POST";
    },
    (e) => {
      e.trace.path = "/api/rehearsal/messages";
    },
    (e) => {
      e.outcome.responseStatus = 503;
    },
    (e) => {
      e.outcome.responseBody = "{}";
    },
    (e) => {
      e.httpAttempts = 2;
    },
    (e) => {
      e.admission = undefined;
    },
    (e) => {
      e.admission.id = "different-request";
    },
    (e) => {
      e.admission.visits = 2;
    },
    (e) => {
      e.admission.responseFinishedAt = null;
    },
  ]) {
    const evidence = idleControlEvidence();
    mutate(evidence);
    assert.throws(() => assessIdleReuseControl(evidence));
  }
  for (const mutate of [
    (e) => {
      e.outcome.errorCode = "EPIPE";
    },
    (e) => {
      e.trace.reusedSocket = false;
    },
    (e) => {
      e.trace.responseHeadersAt = 2500;
    },
    (e) => {
      e.admission = { visits: 1 };
    },
  ]) {
    const evidence = idleControlEvidence(true);
    mutate(evidence);
    assert.throws(() => assessIdleReuseControl(evidence));
  }
});

test("minimum-timeout comparison still requires the exact primed socket within its full idle age", () => {
  const evidence = idleControlEvidence();
  evidence.minimumKeepaliveSeconds = 5;
  evidence.sameSocket = true;
  evidence.trace.reusedSocket = true;
  evidence.trace.localPort = evidence.prime.localPort;
  evidence.beforeReuse.pendingRead = false;
  evidence.afterAttempt.destroyed = false;
  assert.equal(
    assessIdleReuseControl(evidence).classification,
    "minimum-timeout-reuse-preserved",
  );
  const closedAfterResponse = structuredClone(evidence);
  closedAfterResponse.afterAttempt.destroyed = true;
  closedAfterResponse.trace.finishedMonotonic = 2500;
  closedAfterResponse.primedCloseObservedMonotonic = 2600;
  closedAfterResponse.outcome.responseConnection = "close";
  assert.equal(
    assessIdleReuseControl(closedAfterResponse).classification,
    "minimum-timeout-reuse-preserved",
  );
  const responseError = structuredClone(closedAfterResponse);
  responseError.outcome = { status: "rejected", errorCode: "ECONNRESET" };
  assert.throws(() => assessIdleReuseControl(responseError));
  const expired = structuredClone(evidence);
  expired.trace.startedMonotonic = expired.prime.finishedMonotonic + 5000;
  assert.throws(() => assessIdleReuseControl(expired), /Full idle age/);
  const replaced = idleControlEvidence();
  replaced.minimumKeepaliveSeconds = 5;
  assert.throws(() => assessIdleReuseControl(replaced));
});
