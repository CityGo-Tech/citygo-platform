import test from "node:test";
import assert from "node:assert/strict";
import { createClient, createSessionGuard } from "./index.js";

const id = "871802b8-deb3-4235-8f61-9e28a7889a52";
const requestId = "c2529a6e-c322-4b84-a4fd-6056e0ab5e28";
const task = {
  id,
  userId: "1",
  paymentId: "synthetic-payment",
  paymentProvider: "yookassa",
  amountKopeks: 10000,
  cumulativeRefundedKopeks: 0,
  remainingIncomeKopeks: 10000,
  revision: 1,
  registrationStatus: "pending",
  deliveryStatus: "pending",
  correctionStatus: "not_required",
  activeEvidenceId: null,
  activeReceiptId: null,
  activeReceiptUrl: null,
  reviewReason: null,
  buyerEmail: "synthetic@example.test",
  claimedByUserId: null,
  observedAt: "2026-10-18T10:00:00.000Z",
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:00.000Z",
} as const;

test("NPD receipt client validates pagination, identity and commands without automatic retries", async () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const client = createClient("/api", {
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(
        String(url).includes("?")
          ? { tasks: [task], nextAfter: null }
          : { task, events: [] },
      );
    },
  });
  await client.adminNpdReceipts({ status: "review", after: id, limit: 20 });
  await client.adminNpdReceipt(id);
  const command = { action: "claim", requestId, expectedRevision: 1 } as const;
  await client.commandNpdReceipt(id, command);
  assert.deepEqual(requests, [
    {
      url: `/api/v1/admin/npd/receipts?limit=20&status=review&after=${id}`,
      method: "GET",
      body: undefined,
    },
    { url: `/api/v1/admin/npd/receipts/${id}`, method: "GET", body: undefined },
    {
      url: `/api/v1/admin/npd/receipts/${id}/commands`,
      method: "POST",
      body: command,
    },
  ]);
});

test("NPD client rejects malformed inputs before fetch without disclosing rejected PII", async () => {
  let calls = 0;
  const client = createClient("/api", {
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.throws(
    () => client.adminNpdReceipts({ limit: 101 }),
    /Некорректные параметры/,
  );
  assert.throws(
    () =>
      client.adminNpdReceipts({
        limit: 20,
        ...{ privateEmail: "private-person@example.test" },
      }),
    (error: Error) => !error.message.includes("private-person"),
  );
  await assert.rejects(
    client.adminNpdReceipt("private-person@example.test"),
    (error: Error) => !error.message.includes("private-person"),
  );
  await assert.rejects(
    client.commandNpdReceipt(id, {
      action: "register",
      requestId,
      expectedRevision: 1,
      receiptId: "receipt",
      receiptUrl: "https://evil.example.test/private-person",
      amountKopeks: 10000,
      operatorReported: true,
    }),
    (error: Error) => !error.message.includes("private-person"),
  );
  assert.equal(calls, 0);
});

test("NPD client rejects a mismatched task, unsafe evidence and owner DTO containing admin PII", async () => {
  for (const patch of [
    { id: requestId },
    { remainingIncomeKopeks: 1 },
    { activeReceiptUrl: "javascript:alert(1)" },
  ]) {
    const client = createClient("/api", {
      fetch: async () =>
        Response.json({ task: { ...task, ...patch }, events: [] }),
    });
    await assert.rejects(client.adminNpdReceipt(id), /не соответствует/);
  }
  const client = createClient("/api", {
    fetch: async () => Response.json({ tasks: [task] }),
  });
  await assert.rejects(client.npdReceipts(), /не соответствует/);
});

test("NPD client surfaces 403 and CAS conflict without retrying a POST", async () => {
  for (const status of [403, 409]) {
    let calls = 0;
    const client = createClient("/api", {
      fetch: async () => {
        calls++;
        return Response.json({ error: "Обновите реестр" }, { status });
      },
    });
    await assert.rejects(
      client.commandNpdReceipt(id, {
        action: "claim",
        requestId,
        expectedRevision: 1,
      }),
      (error: { status?: number }) => error.status === status,
    );
    assert.equal(calls, 1);
  }
});

test("owner receipt endpoint accepts only the owner-safe projection", async () => {
  const owner: Record<string, unknown> = { ...task };
  delete owner.buyerEmail;
  delete owner.claimedByUserId;
  const client = createClient("/api", {
    fetch: async (url, init) => {
      assert.equal(String(url), "/api/v1/payments/receipts");
      assert.equal(init?.credentials, "include");
      return Response.json({ tasks: [owner] });
    },
  });
  const result = await client.npdReceipts();
  assert.equal(result.tasks[0]?.id, id);
  assert.equal(Object.hasOwn(result.tasks[0]!, "buyerEmail"), false);
  assert.equal(Object.hasOwn(result.tasks[0]!, "claimedByUserId"), false);
});

test("a late NPD receipt response from a closed session cannot publish or expire another session", async () => {
  for (const status of [200, 401, 403]) {
    const session = createSessionGuard();
    let resolve!: (value: Response) => void;
    let expired = 0;
    const client = createClient("/api", {
      signal: () => session.capture().signal,
      onUnauthorized: () => {
        expired++;
      },
      fetch: async () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    });
    const pending = client.adminNpdReceipt(id);
    const rejected = assert.rejects(pending, /прежней сессии/);
    session.reset();
    resolve(Response.json({ task, events: [] }, { status }));
    await rejected;
    assert.equal(expired, 0);
  }
});
