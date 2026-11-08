// Rehearsal acceptance only. Never retries a request or changes production.
// A client can reuse a cached idle socket after Nginx has closed it on HUP.
// Only a read-only fixture probe, proven NOT admitted to API, fits this class.
export function classifyProbeFailures(failures, timeline) {
  const began = timeline.find(
    (entry) => entry.phase === "nginx-hup-requested",
  )?.monotonic;
  const confirmed = timeline.find(
    (entry) => entry.phase === "green-confirmed-old-generation-active",
  )?.monotonic;
  const bounded =
    Number.isFinite(began) && Number.isFinite(confirmed) && began <= confirmed;
  const idleReuseResets = [];
  const unexpectedFailures = [];
  for (const failure of failures) {
    const trace = failure.trace;
    const idle =
      bounded &&
      trace &&
      ["keepalive", "forced-idle-reuse"].includes(failure.kind) &&
      trace.method === "GET" &&
      trace.path === "/api/rehearsal/probe" &&
      trace.reusedSocket === true &&
      failure.code === "ECONNRESET" &&
      trace.code === "ECONNRESET" &&
      trace.responseHeadersAt === null &&
      trace.responseBytes === 0 &&
      failure.admittedToFixtureApi === false &&
      Number.isFinite(trace.startedMonotonic) &&
      Number.isFinite(trace.finishedMonotonic) &&
      trace.startedMonotonic >= began &&
      trace.finishedMonotonic >= trace.startedMonotonic &&
      trace.finishedMonotonic <= confirmed;
    (idle ? idleReuseResets : unexpectedFailures).push(failure);
  }
  return {
    idleReuseResets,
    unexpectedFailures,
    freshFailures: unexpectedFailures.filter(
      (failure) => failure.kind === "fresh",
    ),
    admittedFailures: unexpectedFailures.filter(
      (failure) => failure.admittedToFixtureApi === true,
    ),
    otherFailures: unexpectedFailures.filter(
      (failure) =>
        failure.kind !== "fresh" && failure.admittedToFixtureApi !== true,
    ),
  };
}
