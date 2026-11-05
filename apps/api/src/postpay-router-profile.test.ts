import assert from "node:assert/strict";
import test from "node:test";
import type { PostpayAttempt } from "@citygo/db";
import type { StreamingProvider } from "@citygo/llm";
import {
  selectPostpayRouterAdapter,
  type PostpayRouterProfile,
} from "./postpay-router-profile.js";

const model = "openai/gpt-6.1-sol";
const generation = "gen-synthetic-profile";
const reference = "de0d5b3d-066f-4dcc-a142-047e6b0aac12";
function fixture(protocol: "responses" | "chat/completions") {
  const calls = { modelPosts: 0, costGets: 0 };
  const adapter: StreamingProvider = {
    name: "routerai",
    model,
    async *stream() {
      calls.modelPosts++;
      yield { type: "complete", model };
    },
    async readCharge(id, ref) {
      calls.costGets++;
      assert.equal(id, generation);
      assert.equal(ref, reference);
      return {
        generationId: id,
        reference: ref,
        model,
        upstream: "openai",
        currency: "RUB",
        costRub: "1.23456789",
        amountMicros: 1_234_567,
      };
    },
  };
  const profile: PostpayRouterProfile = {
    adapter,
    upstream: "openai",
    protocol,
    executionKey: (protocol === "responses" ? "a" : "b").repeat(64),
    policyId: (protocol === "responses" ? "c" : "d").repeat(64),
  };
  return { calls, adapter, profile };
}
function identity(profile: PostpayRouterProfile) {
  return {
    model,
    upstream: "openai",
    protocol: profile.protocol,
    execution_key: profile.executionKey!,
    policy_id: profile.policyId!,
  } satisfies Pick<
    PostpayAttempt,
    "model" | "upstream" | "protocol" | "execution_key" | "policy_id"
  >;
}

test("same Maximum model chooses only the exact protocol/execution/policy after reconstruction", async () => {
  const old = fixture("responses"),
    native = fixture("chat/completions");
  // A persisted attempt survives process lifetime; object identity must not be
  // needed to find the same server-owned route after a restart.
  const stored = JSON.parse(JSON.stringify(identity(native.profile)));
  const restarted = [{ ...old.profile }, { ...native.profile }];
  const selected = selectPostpayRouterAdapter(restarted, stored);
  assert.equal(selected, native.adapter);
  assert.equal(old.calls.costGets, 0);
  assert.equal(native.calls.costGets, 0);
  await selected!.readCharge(
    generation,
    reference,
    new AbortController().signal,
  );
  assert.deepEqual(old.calls, { modelPosts: 0, costGets: 0 });
  assert.deepEqual(native.calls, { modelPosts: 0, costGets: 1 });
  assert.equal(
    selectPostpayRouterAdapter(restarted, identity(old.profile)),
    old.adapter,
  );
});

test("wrong protocol, execution, policy, upstream or model cannot read another profile's receipt", () => {
  const old = fixture("responses"),
    native = fixture("chat/completions");
  const actual = identity(native.profile);
  for (const patch of [
    { protocol: "responses" as const },
    { protocol: "gigachat" as const },
    { execution_key: "a".repeat(64) },
    { policy_id: "c".repeat(64) },
    { upstream: "deepseek" },
    { model: "deepseek/deepseek-v4-pro-0813" },
  ])
    assert.equal(
      selectPostpayRouterAdapter([old.profile, native.profile], {
        ...actual,
        ...patch,
      }),
      undefined,
    );
  assert.deepEqual(old.calls, { modelPosts: 0, costGets: 0 });
  assert.deepEqual(native.calls, { modelPosts: 0, costGets: 0 });
});

test("missing adapter, wrong provider and exact adapter without readCharge never fall back", () => {
  const native = fixture("chat/completions");
  const attempt = identity(native.profile);
  const noReader = { ...native.adapter, readCharge: undefined };
  for (const adapter of [
    undefined,
    { ...native.adapter, name: "gigachat" as const },
    noReader,
  ])
    assert.equal(
      selectPostpayRouterAdapter([{ ...native.profile, adapter }], attempt),
      undefined,
    );
  assert.equal(
    selectPostpayRouterAdapter(
      [{ ...native.profile, adapter: noReader }, native.profile],
      attempt,
    ),
    undefined,
  );
  assert.deepEqual(native.calls, { modelPosts: 0, costGets: 0 });
});

test("legacy global Chat fallback cannot consume an explicit mode execution", () => {
  const chat = fixture("chat/completions");
  const globalProfile: PostpayRouterProfile = {
    ...chat.profile,
    executionKey: null,
    policyId: null,
  };
  // Current mode attempts always have digests, so a global fallback cannot
  // consume a receipt belonging to a newer explicit execution.
  assert.equal(
    selectPostpayRouterAdapter([globalProfile], identity(chat.profile)),
    undefined,
  );
  assert.equal(
    selectPostpayRouterAdapter([chat.profile], identity(chat.profile)),
    chat.adapter,
  );
  assert.deepEqual(chat.calls, { modelPosts: 0, costGets: 0 });
});
