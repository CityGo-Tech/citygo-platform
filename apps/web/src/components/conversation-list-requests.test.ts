import test from "node:test";
import assert from "node:assert/strict";
import { createConversationListRequests } from "./conversation-list-requests";

test("a changed search, later page or owner reset rejects earlier conversation list responses", () => {
  const requests = createConversationListRequests();
  const oldSearch = requests.begin({ search: "old" });
  const newSearch = requests.begin({ search: "new", status: "active" });
  assert.equal(oldSearch(), false);
  assert.equal(newSearch(), true);
  const laterPage = requests.begin({ search: "new", status: "active" });
  assert.equal(newSearch(), false);
  assert.equal(laterPage(), true);
  requests.reset();
  assert.equal(laterPage(), false);
  assert.equal(requests.begin({})(), true);
});
