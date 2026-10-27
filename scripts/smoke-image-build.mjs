import assert from "node:assert/strict";

// Compose may inject distinct per-service image labels even for the same
// Dockerfile target. Build jobs once, then execute that exact immutable artifact
// as both migrator and worker. Never relax the downstream image-identity gate.
export function buildSmokeImages({ project, compose, docker }) {
  assert.match(project, /^citygo-smoke-[a-f0-9]{12}$/);
  compose(["build", "api", "web", "migrator"], {
    timeout: 30 * 60 * 1000,
  });
  const inspect = (tag) =>
    docker(["image", "inspect", "--format", "{{.Id}}", tag]).trim();
  const jobs = inspect(`${project}-migrator`);
  assert.match(jobs, /^sha256:[a-f0-9]{64}$/);
  docker(["tag", jobs, `${project}-worker`]);
  assert.equal(inspect(`${project}-worker`), jobs);
}
