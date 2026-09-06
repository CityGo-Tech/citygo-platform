import assert from "node:assert/strict";
import test from "node:test";

import { agentCatalog } from "./catalog.js";

test("agent ids are unique and every agent defines a handoff", () => {
  const ids = agentCatalog.map((agent) => agent.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    agentCatalog.every((agent) => agent.handoffWhen.length > 0),
    true,
  );
});
