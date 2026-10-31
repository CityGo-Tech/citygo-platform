import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { SupportRequest } from "@citygo/contracts";
import {
  createHumanSupportResource,
  type SupportState,
} from "./human-support-state";
const body = "Помогите разобраться с первым шагом моего переезда.";
const item: SupportRequest = {
  id: "9007199254740993",
  operationId: "41111111-1111-4111-8111-111111111111",
  body,
  status: "open",
  revision: 1,
  createdAt: "2026-10-30T10:00:00Z",
  updatedAt: "2026-10-30T10:00:00Z",
  closedAt: null,
};
test("a definitive validation failure unlocks the editor instead of retaining an uncertain operation forever", async () => {
  const states: SupportState[] = [];
  const resource = createHumanSupportResource({
    userId: "1",
    signal: new AbortController().signal,
    operationId: () => item.operationId,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    client: {
      supportRequests: async () => ({
        userId: "1",
        requests: [],
        nextBefore: null,
      }),
      createSupportRequest: async () => {
        throw new ApiError(400, "Invalid text", "http");
      },
    },
  });
  await resource.send(body);
  assert.equal(states.at(-1)?.pending, null);
  assert.equal(states.at(-1)?.busy, false);
  assert.match(states.at(-1)?.error ?? "", /не сохранён/);
});
test("unknown support creation retries only the same explicit body and operation, and receipt uses actual saved identity", async () => {
  const signal = new AbortController(),
    states: SupportState[] = [],
    commands: unknown[] = [];
  let attempts = 0;
  const resource = createHumanSupportResource({
    userId: "1",
    signal: signal.signal,
    operationId: () => item.operationId,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    client: {
      supportRequests: async () => ({
        userId: "1",
        requests: [],
        nextBefore: null,
      }),
      createSupportRequest: async (input) => {
        commands.push(input);
        if (++attempts === 1) throw new Error("lost response");
        return { userId: "1", request: item };
      },
    },
  });
  await resource.load();
  await resource.send(body);
  assert.ok(states.at(-1)?.pending);
  await resource.send(
    "Изменённый вопрос, который нельзя послать вместо прежнего.",
  );
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(states.at(-1)?.receipt?.id, item.id);
  assert.equal(states.at(-1)?.pending, null);
});
test("late owner response after disposal or session abort never publishes private support text", async () => {
  let resolve!: (value: {
    userId: string;
    requests: SupportRequest[];
    nextBefore: null;
  }) => void;
  const waiting = new Promise<{
    userId: string;
    requests: SupportRequest[];
    nextBefore: null;
  }>((r) => {
    resolve = r;
  });
  const signal = new AbortController(),
    states: SupportState[] = [];
  const resource = createHumanSupportResource({
    userId: "1",
    signal: signal.signal,
    operationId: () => item.operationId,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    client: {
      supportRequests: () => waiting,
      createSupportRequest: async () => ({ userId: "1", request: item }),
    },
  });
  const pending = resource.load();
  signal.abort();
  resource.dispose();
  resolve({ userId: "1", requests: [item], nextBefore: null });
  await pending;
  assert.equal(states.length, 1);
  assert.deepEqual(states[0]?.requests, []);
});
test("a structurally valid response for another owner clears private state and denies access", async () => {
  let denied = 0;
  const states: SupportState[] = [];
  const resource = createHumanSupportResource({
    userId: "1",
    signal: new AbortController().signal,
    operationId: () => item.operationId,
    publish: (s) => states.push(s),
    onAccessDenied: () => denied++,
    client: {
      supportRequests: async () => ({
        userId: "2",
        requests: [item],
        nextBefore: null,
      }),
      createSupportRequest: async () => ({ userId: "2", request: item }),
    },
  });
  await resource.load();
  assert.equal(denied, 1);
  assert.deepEqual(states.at(-1)?.requests, []);
});

test("notice opens an exact owned request outside the first list page without marking read", async () => {
  const states: SupportState[] = [];
  const request = {
    id: "9007199254740993",
    operationId: "41111111-1111-4111-8111-111111111111",
    body: "Помогите выбрать первый шаг переезда.",
    status: "open" as const,
    revision: 1,
    createdAt: "2026-10-31T10:00:00Z",
    updatedAt: "2026-10-31T10:00:00Z",
    closedAt: null,
  };
  const resource = createHumanSupportResource({
    userId: "1",
    signal: new AbortController().signal,
    operationId: () => request.operationId,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    client: {
      supportRequests: async () => ({
        userId: "1",
        requests: [],
        nextBefore: null,
      }),
      createSupportRequest: async () => {
        throw Error("not called");
      },
      supportRequest: async (id) => {
        assert.equal(id, request.id);
        return { userId: "1", request };
      },
    },
  });
  await resource.load();
  assert.equal(await resource.open(request.id), true);
  assert.deepEqual(states.at(-1)!.requests, [request]);
  resource.dispose();
});

test("a late direct-open result after cancellation never restores the previous account request", async () => {
  const states: SupportState[] = [],
    controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const resource = createHumanSupportResource({
    userId: "1",
    signal: controller.signal,
    operationId: () => item.operationId,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    client: {
      supportRequests: async () => ({
        userId: "1",
        requests: [],
        nextBefore: null,
      }),
      createSupportRequest: async () => {
        throw Error("not called");
      },
      supportRequest: async () => {
        await gate;
        return { userId: "1", request: item };
      },
    },
  });
  await resource.load();
  const pending = resource.open(item.id),
    count = states.length;
  controller.abort();
  release();
  assert.equal(await pending, false);
  assert.equal(states.length, count);
  assert.deepEqual(states.at(-1)!.requests, []);
  resource.dispose();
});

test("opening an older notice before loading its keyset page keeps one exact bigint row and adopts the newly fetched state", async () => {
  const base = 9007199254740993n,
    states: SupportState[] = [],
    reads: unknown[] = [];
  const row = (id: bigint, revision = 1): SupportRequest => ({
    ...item,
    id: String(id),
    revision,
    status: revision > 1 ? "closed" : "open",
    closedAt: revision > 1 ? "2026-11-01T00:00:00Z" : null,
  });
  const resource = createHumanSupportResource({
    userId: "1",
    signal: new AbortController().signal,
    operationId: () => item.operationId,
    publish: (state) => states.push(state),
    onAccessDenied: () => assert.fail(),
    client: {
      supportRequests: async (query) => {
        reads.push(query);
        return {
          userId: "1",
          requests: query?.before
            ? [row(base, 2)]
            : Array.from({ length: 20 }, (_, index) =>
                row(base + 20n - BigInt(index)),
              ),
          nextBefore: query?.before ? null : String(base + 1n),
        };
      },
      supportRequest: async (id) => {
        assert.equal(id, String(base));
        return { userId: "1", request: row(base) };
      },
      createSupportRequest: async () => {
        throw new Error(
          "No support creation or read acknowledgement is expected",
        );
      },
    },
  });
  await resource.load();
  assert.equal(await resource.open(String(base)), true);
  assert.equal(states.at(-1)!.requests.length, 21);
  assert.equal(states.at(-1)!.nextBefore, String(base + 1n));
  await resource.load(states.at(-1)!.nextBefore!);
  const latest = states.at(-1)!;
  assert.equal(latest.error, "");
  assert.equal(latest.requests.length, 21);
  assert.equal(new Set(latest.requests.map((request) => request.id)).size, 21);
  assert.deepEqual(
    latest.requests.map((request) => request.id),
    Array.from({ length: 21 }, (_, index) =>
      String(base + 20n - BigInt(index)),
    ),
  );
  assert.equal(latest.requests.at(-1)!.revision, 2);
  assert.equal(latest.requests.at(-1)!.status, "closed");
  assert.equal(latest.nextBefore, null);
  assert.deepEqual(reads, [{}, { before: String(base + 1n) }]);
  resource.dispose();
});

test("merging an opened older request does not conceal malformed server pages or a foreign owner", async () => {
  const base = 9007199254740993n;
  const row = (id: bigint): SupportRequest => ({ ...item, id: String(id) });
  for (const scenario of [
    "duplicate",
    "unordered",
    "outside-keyset",
    "bad-next-cursor",
    "foreign-owner",
  ] as const) {
    const states: SupportState[] = [];
    let denied = 0;
    const resource = createHumanSupportResource({
      userId: "1",
      signal: new AbortController().signal,
      operationId: () => item.operationId,
      publish: (state) => states.push(state),
      onAccessDenied: () => {
        denied++;
      },
      client: {
        supportRequests: async (query) => {
          if (!query?.before)
            return {
              userId: "1",
              requests: Array.from({ length: 20 }, (_, index) =>
                row(base + 20n - BigInt(index)),
              ),
              nextBefore: String(base + 1n),
            };
          return {
            userId: scenario === "foreign-owner" ? "2" : "1",
            requests:
              scenario === "duplicate"
                ? [row(base), row(base)]
                : scenario === "unordered"
                  ? [row(base - 1n), row(base)]
                  : scenario === "outside-keyset"
                    ? [row(base + 1n)]
                    : [row(base)],
            nextBefore: scenario === "bad-next-cursor" ? String(base) : null,
          };
        },
        supportRequest: async () => ({ userId: "1", request: row(base) }),
        createSupportRequest: async () => {
          throw new Error("No mutation expected");
        },
      },
    });
    await resource.load();
    await resource.open(String(base));
    const prior = states.at(-1)!.requests;
    await resource.load(String(base + 1n));
    if (scenario === "foreign-owner") {
      assert.equal(denied, 1);
      assert.deepEqual(states.at(-1)!.requests, []);
    } else {
      assert.equal(denied, 0);
      assert.deepEqual(states.at(-1)!.requests, prior);
      assert.match(states.at(-1)!.error, /Не удалось загрузить/);
    }
    resource.dispose();
  }
});
