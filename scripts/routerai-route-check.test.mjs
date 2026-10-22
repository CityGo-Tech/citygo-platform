import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectRouterAiRoute,
  parseRouterAiRouteArgs,
  runRouterAiRouteCheck,
} from "./routerai-route-check.mjs";

const model = "deepseek/deepseek-v4-pro-0813";
const options = {
  model,
  upstream: "deepseek",
  country: "cn",
  maxOutputTokens: 2048,
  reasoningEffort: "high",
};
const args = [
  "--model",
  model,
  "--upstream",
  "deepseek",
  "--country",
  "cn",
  "--max-output-tokens",
  "2048",
  "--reasoning-effort",
  "high",
];
const endpoint = {
  tag: "deepseek",
  country: "cn",
  countries: ["cn"],
  status: 0,
  supported_parameters: ["max_tokens", "reasoning"],
  max_completion_tokens: 393216,
  pricing: {
    prompt: 0.00010044158124,
    completion: 0.00030132474372,
    input_cache_read: 0.000003348052708,
  },
  pricing_units: {
    prompt: "token",
    completion: "token",
    input_cache_read: "token",
  },
  variable_pricings: [
    {
      type: "time-of-day",
      periods: [{ start: "00:00", end: "08:00", multiplier: 0.5 }],
    },
  ],
};
function catalog(change = {}) {
  return {
    data: {
      id: model,
      endpoints: [{ ...structuredClone(endpoint), ...change }],
    },
  };
}
function json(value, init) {
  return Response.json(value, init);
}
function harness(fetchImpl, extra = {}) {
  let stdout = "",
    stderr = "",
    calls = 0;
  return {
    async run(input = args) {
      const code = await runRouterAiRouteCheck(input, {
        ...extra,
        fetchImpl: (...request) => {
          calls++;
          return fetchImpl(...request);
        },
        writeOut: (value) => {
          stdout += value;
        },
        writeError: (value) => {
          stderr += value;
        },
      });
      return { code, stdout, stderr, calls };
    },
  };
}
const shapeError = (error) =>
  /^ROUTERAI_CATALOG_(?:SHAPE_INVALID|ENDPOINT_AMBIGUOUS)$/.test(error.code);

test("pure inspection reports exact public route and token prices without authorization, currency or reserve claims", () => {
  const input = catalog(),
    original = structuredClone(input);
  const result = inspectRouterAiRoute(input, options);
  assert.equal(result.routeMatchesCatalog, true);
  assert.equal(result.countryConflict, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.matchedEndpoint.tag, "deepseek");
  assert.equal(result.matchedEndpoint.maxCompletionTokens, 393216);
  assert.equal(result.matchedEndpoint.reasoningParameterSupported, true);
  assert.equal(result.matchedEndpoint.reasoningEffortVerified, false);
  assert.deepEqual(result.pricingPerToken, {
    prompt: { value: 0.00010044158124, unit: "token" },
    completion: { value: 0.00030132474372, unit: "token" },
    input_cache_read: { value: 0.000003348052708, unit: "token" },
  });
  assert.equal(result.variablePricingPresent, true);
  assert.equal(result.variablePricingCount, 1);
  assert.match(result.note, /not authorization/);
  for (const field of [
    "authorized",
    "reserve",
    "cost",
    "currency",
    "countryOfStorage",
  ])
    assert.equal(Object.hasOwn(result, field), false);
  assert.deepEqual(input, original);
});

test("country mismatch is explicit; a multi-country list cannot establish forced processing location", () => {
  for (const input of [catalog(), catalog({ countries: ["cn", "us"] })]) {
    const result = inspectRouterAiRoute(input, { ...options, country: "us" });
    assert.equal(result.routeMatchesCatalog, false);
    assert.equal(result.countryConflict, true);
    assert.deepEqual(result.blockers, ["country_mismatch"]);
    assert.equal(result.matchedEndpoint.country, "cn");
  }
});

test("exact model ID and endpoint status/cap/parameters are independently checked", () => {
  const mismatched = catalog();
  mismatched.data.id = "deepseek/another-model";
  assert.deepEqual(inspectRouterAiRoute(mismatched, options).blockers, [
    "catalog_model_mismatch",
  ]);
  const cases = [
    [{ status: 1 }, "endpoint_status_not_zero"],
    [{ supported_parameters: ["reasoning"] }, "max_tokens_not_listed"],
    [{ supported_parameters: ["max_tokens"] }, "reasoning_not_listed"],
    [{ max_completion_tokens: 2047 }, "max_output_tokens_exceeds_catalog_cap"],
  ];
  for (const [change, blocker] of cases) {
    const result = inspectRouterAiRoute(catalog(change), options);
    assert.equal(result.routeMatchesCatalog, false);
    assert.deepEqual(result.blockers, [blocker]);
  }
  const withoutEffort = { ...options };
  delete withoutEffort.reasoningEffort;
  assert.equal(
    inspectRouterAiRoute(
      catalog({ supported_parameters: ["max_tokens"] }),
      withoutEffort,
    ).routeMatchesCatalog,
    true,
  );
  assert.equal(
    inspectRouterAiRoute(catalog(), { ...options, maxOutputTokens: 393216 })
      .routeMatchesCatalog,
    true,
  );
});

test("no provider fallback is chosen when exact tag is absent or unavailable", () => {
  const missing = inspectRouterAiRoute(
    catalog({ tag: "other-provider" }),
    options,
  );
  assert.equal(missing.routeMatchesCatalog, false);
  assert.equal(missing.matchedEndpoint, null);
  assert.equal(missing.countryConflict, null);
  assert.equal(missing.pricingPerToken, null);
  assert.equal(missing.variablePricingPresent, null);
  assert.deepEqual(missing.blockers, ["exact_upstream_not_listed"]);
  const input = catalog({ status: 2 });
  input.data.endpoints.push({
    ...structuredClone(endpoint),
    tag: "other-provider",
  });
  assert.deepEqual(inspectRouterAiRoute(input, options).blockers, [
    "endpoint_status_not_zero",
  ]);
});

test("duplicate matching tag, inconsistent countries and malformed catalog fields fail safely", () => {
  const duplicate = catalog();
  duplicate.data.endpoints.push(structuredClone(endpoint));
  for (const input of [
    duplicate,
    {},
    { data: [] },
    { data: { id: model, endpoints: {} } },
    { data: { id: "private-person@example.test", endpoints: [] } },
    catalog({ tag: null }),
    catalog({ status: "0" }),
    catalog({ status: -1 }),
    catalog({ country: "CN" }),
    catalog({ countries: ["us"] }),
    catalog({ countries: [] }),
    catalog({ countries: ["cn", "cn"] }),
    catalog({ supported_parameters: ["max_tokens", "max_tokens"] }),
    catalog({ supported_parameters: {} }),
    catalog({ max_completion_tokens: "393216" }),
    catalog({ max_completion_tokens: 0 }),
    catalog({ pricing: { prompt: -1, completion: 0 } }),
    catalog({
      pricing_units: { ...endpoint.pricing_units, prompt: "million_tokens" },
    }),
    catalog({ pricing: { ...endpoint.pricing, prompt: Infinity } }),
    catalog({ variable_pricings: {} }),
    catalog({ variable_pricings: [null] }),
    catalog({ variable_pricings: [{}] }),
  ])
    assert.throws(() => inspectRouterAiRoute(input, options), shapeError);
});

test("decimal price strings are preserved rather than converted to floating-point estimates", () => {
  const result = inspectRouterAiRoute(
    catalog({
      pricing: { ...endpoint.pricing, prompt: "0.00010044158124000001" },
      variable_pricings: [],
    }),
    options,
  );
  assert.deepEqual(result.pricingPerToken.prompt, {
    value: "0.00010044158124000001",
    unit: "token",
  });
  assert.equal(result.variablePricingPresent, false);
  assert.equal(result.variablePricingDeclared, true);
  const absent = catalog();
  delete absent.data.endpoints[0].variable_pricings;
  const inspected = inspectRouterAiRoute(absent, options);
  assert.equal(inspected.variablePricingPresent, false);
  assert.equal(inspected.variablePricingDeclared, false);
});

test("raw metadata and unrecognized extra fields never appear in inspection output", () => {
  const input = catalog({
    privateSecret: "SYNTHETIC-NEVER-OUTPUT",
    variable_pricings: [{ arbitraryPrivateField: "SYNTHETIC-NEVER-OUTPUT" }],
  });
  input.data.secret = "SYNTHETIC-NEVER-OUTPUT";
  const serialized = JSON.stringify(inspectRouterAiRoute(input, options));
  assert.ok(!serialized.includes("SYNTHETIC-NEVER-OUTPUT"));
  assert.ok(!serialized.includes("arbitraryPrivateField"));
  assert.equal(JSON.parse(serialized).variablePricingPresent, true);
});

test("arguments are explicit and validated; no URL/key/prompt/env override or duplicate flags are accepted", () => {
  assert.deepEqual(parseRouterAiRouteArgs(args), options);
  for (const bad of [
    [],
    args.slice(0, -1),
    [...args, "--country", "cn"],
    [...args, "--url", "https://elsewhere.example.test"],
    [...args, "--key", "SYNTHETIC-SECRET"],
    [...args, "--prompt", "SYNTHETIC-PRIVATE-PROMPT"],
    args.map((value) => (value === model ? "deepseek/../../private" : value)),
    args.map((value) =>
      value === model ? "deepseek/model?api_key=secret" : value,
    ),
    args.map((value) => (value === "2048" ? "0" : value)),
    args.map((value) => (value === "2048" ? "2e3" : value)),
    args.map((value) => (value === "2048" ? "2147483648" : value)),
    args.map((value) => (value === "high" ? "unknown" : value)),
    args.map((value) => (value === "cn" ? "CN" : value)),
  ])
    assert.throws(() => parseRouterAiRouteArgs(bad), {
      code: "ROUTERAI_ROUTE_ARGUMENTS_INVALID",
    });
  for (const bad of [
    { ...options, secret: "SYNTHETIC-SECRET" },
    { ...options, maxOutputTokens: NaN },
  ])
    assert.throws(() => inspectRouterAiRoute(catalog(), bad), {
      code: "ROUTERAI_ROUTE_ARGUMENTS_INVALID",
    });
});

test("CLI issues exactly one fixed public GET, without auth/cookies/body or redirects", async () => {
  const h = harness(async (url, init) => {
    assert.equal(url, `https://routerai.ru/api/v1/models/${model}/endpoints`);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(Object.hasOwn(init, "body"), false);
    assert.deepEqual(init.headers, { Accept: "application/json" });
    assert.ok(init.signal instanceof AbortSignal);
    return json(catalog());
  });
  const result = await h.run();
  assert.equal(result.code, 0);
  assert.equal(result.calls, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).routeMatchesCatalog, true);
});

test("CLI incompatible route returns exit 2, HTTP/shape failure exit 3, with sanitized output and no retry", async () => {
  const conflict = await harness(async () => json(catalog())).run(
    args.map((value) => (value === "cn" ? "us" : value)),
  );
  assert.equal(conflict.code, 2);
  assert.equal(JSON.parse(conflict.stdout).countryConflict, true);
  assert.equal(conflict.stderr, "");
  for (const response of [
    new Response("SYNTHETIC-SECRET", {
      status: 502,
      headers: { "content-type": "text/html" },
    }),
    json({ privateSecret: "SYNTHETIC-SECRET" }),
    new Response("SYNTHETIC-SECRET", {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const result = await harness(async () => response).run();
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "");
    assert.equal(result.calls, 1);
    assert.ok(!result.stderr.includes("SYNTHETIC-SECRET"));
    assert.ok(JSON.parse(result.stderr).error.startsWith("ROUTERAI_CATALOG_"));
  }
});

test("CLI refuses invalid args before fetch and never reflects rejected arguments or transport errors", async () => {
  const invalid = await harness(async () => {
    throw new Error("must not fetch");
  }).run([...args, "--prompt", "SYNTHETIC-PRIVATE-PROMPT"]);
  assert.equal(invalid.code, 3);
  assert.equal(invalid.calls, 0);
  assert.equal(invalid.stdout, "");
  assert.equal(
    invalid.stderr,
    '{"error":"ROUTERAI_ROUTE_ARGUMENTS_INVALID"}\n',
  );
  const failed = await harness(async () => {
    throw new Error("https://private/SYNTHETIC-SECRET");
  }).run();
  assert.equal(failed.code, 3);
  assert.equal(failed.stderr, '{"error":"ROUTERAI_CATALOG_READ_FAILED"}\n');
});

test("redirected and non-JSON responses are rejected; no error body is read or printed", async () => {
  const redirected = json(catalog());
  Object.defineProperty(redirected, "redirected", { value: true });
  const wrongUrl = json(catalog());
  Object.defineProperty(wrongUrl, "url", {
    value: "https://private.example.test/SYNTHETIC-SECRET",
  });
  for (const response of [
    redirected,
    wrongUrl,
    new Response("SYNTHETIC-SECRET", {
      headers: { "content-type": "text/html" },
    }),
  ]) {
    const result = await harness(async () => response).run();
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("SYNTHETIC-SECRET"));
  }
});

test("1 MiB limit applies to declared and actual bytes, not a lying Content-Length", async () => {
  for (const declared of [String(1024 * 1024 + 1), "1", undefined]) {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          ...(declared ? { "content-length": declared } : {}),
        },
      },
    );
    const result = await harness(async () => response).run();
    assert.equal(result.code, 3);
    assert.equal(result.stderr, '{"error":"ROUTERAI_CATALOG_TOO_LARGE"}\n');
    assert.equal(canceled, true);
  }
  const body = JSON.stringify(catalog()).padEnd(1024 * 1024, " ");
  const exact = await harness(
    async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
  ).run();
  assert.equal(exact.code, 0);
});

test("bounded stream accepts split UTF-8 but rejects invalid UTF-8 instead of replacement decoding", async () => {
  const input = catalog();
  input.data.description = "Москва";
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  let offset = 0;
  const valid = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
  assert.equal((await harness(async () => valid).run()).code, 0);
  const invalid = await harness(
    async () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
  ).run();
  assert.equal(invalid.code, 3);
  assert.equal(invalid.stdout, "");
});

test(
  "absolute deadline covers ignored fetch abort and cancels a late body",
  { timeout: 2000 },
  async () => {
    let done, signal;
    const pending = new Promise((resolve) => {
      done = resolve;
    });
    const h = harness(
      async (_url, init) => {
        signal = init.signal;
        return pending;
      },
      { timeoutMs: 20 },
    );
    const result = await h.run();
    assert.equal(result.code, 3);
    assert.equal(result.stderr, '{"error":"ROUTERAI_CATALOG_TIMEOUT"}\n');
    assert.equal(signal.aborted, true);
    let canceled = false;
    done(
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(canceled, true);
  },
);

test(
  "absolute deadline covers stalled response bodies and uncooperative cancellation without hanging",
  { timeout: 2000 },
  async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
          return new Promise(() => {});
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const result = await harness(async () => response, { timeoutMs: 20 }).run();
    assert.equal(result.code, 3);
    assert.equal(result.stderr, '{"error":"ROUTERAI_CATALOG_TIMEOUT"}\n');
    assert.equal(canceled, true);
  },
);
