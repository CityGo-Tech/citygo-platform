import assert from "node:assert/strict";
import test from "node:test";
import { classifyProbeFailures } from "./web-switch-transport.mjs";

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
