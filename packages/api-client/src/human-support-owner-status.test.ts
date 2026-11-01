import assert from "node:assert/strict";
import test from "node:test";
import { createClient, ApiError } from "./index.js";

test("owner support status client uses PATCH and rejects a foreign resource or unreviewed revision", async () => {
  const id = "9223372036854775807",
    body = "Помогите разобраться с первым шагом моего переезда.";
  const item = {
    id,
    operationId: "11111111-1111-4111-8111-111111111111",
    body,
    status: "closed",
    revision: 2,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:01:00Z",
    closedAt: "2026-11-01T00:01:00Z",
  };
  let mode = "ok",
    calls = 0;
  const client = createClient("http://example.test", {
    fetch: async (url, init) => {
      calls++;
      assert.equal(
        String(url),
        "http://example.test/v1/support-requests/" + id,
      );
      assert.equal(init?.method, "PATCH");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        expectedRevision: 1,
        status: "closed",
      });
      return new Response(
        JSON.stringify({
          userId: "1",
          request: {
            ...item,
            ...(mode === "foreign" ? { id: "2" } : {}),
            ...(mode === "revision" ? { revision: 3 } : {}),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(
    (
      await client.setOwnSupportRequestStatus(id, {
        expectedRevision: 1,
        status: "closed",
      })
    ).request.id,
    id,
  );
  for (mode of ["foreign", "revision"])
    await assert.rejects(
      client.setOwnSupportRequestStatus(id, {
        expectedRevision: 1,
        status: "closed",
      }),
      (e: unknown) => e instanceof ApiError && e.code === "invalid_response",
    );
  await assert.rejects(
    client.setOwnSupportRequestStatus("01", {
      expectedRevision: 1,
      status: "closed",
    }),
  );
  assert.equal(calls, 3);
});
