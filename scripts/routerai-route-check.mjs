import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const origin = "https://routerai.ru";
const maxBytes = 1024 * 1024;
const defaultTimeoutMs = 10_000;
const modelPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const countryPattern = /^[a-z]{2}$/;
const parameterPattern = /^[a-z][a-z0-9_]{0,63}$/;
const efforts = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const note =
  "Public catalog metadata only: not authorization, country-of-processing/storage proof, generation success or a price/reservation guarantee.";

class RouteCheckError extends Error {
  constructor(code, httpStatus) {
    super(code);
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}
function fail(code = "ROUTERAI_CATALOG_SHAPE_INVALID") {
  throw new RouteCheckError(code);
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function optionsChecked(options) {
  if (
    !record(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          "model",
          "upstream",
          "country",
          "maxOutputTokens",
          "reasoningEffort",
        ].includes(key),
    ) ||
    typeof options.model !== "string" ||
    !modelPattern.test(options.model) ||
    typeof options.upstream !== "string" ||
    !tagPattern.test(options.upstream) ||
    typeof options.country !== "string" ||
    !countryPattern.test(options.country) ||
    !Number.isSafeInteger(options.maxOutputTokens) ||
    options.maxOutputTokens < 1 ||
    options.maxOutputTokens > 2_147_483_647 ||
    (options.reasoningEffort !== undefined &&
      !efforts.has(options.reasoningEffort))
  )
    fail("ROUTERAI_ROUTE_ARGUMENTS_INVALID");
  return {
    model: options.model,
    upstream: options.upstream,
    country: options.country,
    maxOutputTokens: options.maxOutputTokens,
    ...(options.reasoningEffort !== undefined
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
  };
}
function stringList(value, pattern, maxLength, allowEmpty = false) {
  if (
    !Array.isArray(value) ||
    value.length > maxLength ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || !pattern.test(item)) ||
    new Set(value).size !== value.length
  )
    fail();
  return [...value];
}
function price(value) {
  if (
    (typeof value === "number" && Number.isFinite(value) && value >= 0) ||
    (typeof value === "string" &&
      value.length <= 100 &&
      /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))
  )
    return value;
  fail();
}

/** Pure inspection. Exact tag only; never chooses a substitute provider/model.
 * Pricing is reported as catalog metadata, never converted into a reserve.
 * Generic `reasoning` support does not prove an exact effort level is accepted.
 */
export function inspectRouterAiRoute(catalog, rawOptions) {
  const requested = optionsChecked(rawOptions);
  if (
    !record(catalog) ||
    !record(catalog.data) ||
    typeof catalog.data.id !== "string" ||
    !modelPattern.test(catalog.data.id) ||
    !Array.isArray(catalog.data.endpoints) ||
    catalog.data.endpoints.length > 512
  )
    fail();
  const endpoints = catalog.data.endpoints;
  if (
    endpoints.some(
      (endpoint) =>
        !record(endpoint) ||
        typeof endpoint.tag !== "string" ||
        !tagPattern.test(endpoint.tag),
    )
  )
    fail();
  const matching = endpoints.filter(
    (endpoint) => endpoint.tag === requested.upstream,
  );
  if (matching.length > 1) fail("ROUTERAI_CATALOG_ENDPOINT_AMBIGUOUS");
  const blockers = [];
  if (catalog.data.id !== requested.model)
    blockers.push("catalog_model_mismatch");
  const base = { requested, catalogModelId: catalog.data.id, note };
  if (matching.length === 0)
    return {
      ...base,
      routeMatchesCatalog: false,
      blockers: [...blockers, "exact_upstream_not_listed"],
      countryConflict: null,
      matchedEndpoint: null,
      pricingPerToken: null,
      variablePricingPresent: null,
      variablePricingCount: null,
    };
  const endpoint = matching[0];
  if (
    typeof endpoint.country !== "string" ||
    !countryPattern.test(endpoint.country) ||
    !Number.isSafeInteger(endpoint.status) ||
    endpoint.status < 0 ||
    !Number.isSafeInteger(endpoint.max_completion_tokens) ||
    endpoint.max_completion_tokens < 1 ||
    !record(endpoint.pricing) ||
    !record(endpoint.pricing_units)
  )
    fail();
  const countries = stringList(endpoint.countries, countryPattern, 256);
  if (!countries.includes(endpoint.country)) fail();
  const supportedParameters = stringList(
    endpoint.supported_parameters,
    parameterPattern,
    256,
    true,
  );
  const pricingPerToken = {};
  for (const field of ["prompt", "completion", "input_cache_read"]) {
    const present = Object.hasOwn(endpoint.pricing, field),
      unitPresent = Object.hasOwn(endpoint.pricing_units, field);
    if (field === "input_cache_read" && !present && !unitPresent) continue;
    if (!present || !unitPresent || endpoint.pricing_units[field] !== "token")
      fail();
    pricingPerToken[field] = {
      value: price(endpoint.pricing[field]),
      unit: "token",
    };
  }
  const variablePricingDeclared = Object.hasOwn(endpoint, "variable_pricings");
  if (
    variablePricingDeclared &&
    (!Array.isArray(endpoint.variable_pricings) ||
      endpoint.variable_pricings.length > 256 ||
      endpoint.variable_pricings.some(
        (item) => !record(item) || Object.keys(item).length === 0,
      ))
  )
    fail();
  const variablePricingCount = variablePricingDeclared
    ? endpoint.variable_pricings.length
    : 0;
  // Conservatively require both the primary country and the listed countries.
  // A multi-country list does not prove a request can force the requested one.
  const countryConflict =
    endpoint.country !== requested.country ||
    !countries.includes(requested.country);
  if (countryConflict) blockers.push("country_mismatch");
  if (endpoint.status !== 0) blockers.push("endpoint_status_not_zero");
  if (!supportedParameters.includes("max_tokens"))
    blockers.push("max_tokens_not_listed");
  if (requested.maxOutputTokens > endpoint.max_completion_tokens)
    blockers.push("max_output_tokens_exceeds_catalog_cap");
  if (
    requested.reasoningEffort !== undefined &&
    !supportedParameters.includes("reasoning")
  )
    blockers.push("reasoning_not_listed");
  return {
    ...base,
    routeMatchesCatalog: blockers.length === 0,
    blockers,
    countryConflict,
    matchedEndpoint: {
      tag: endpoint.tag,
      status: endpoint.status,
      country: endpoint.country,
      countries,
      supportedParameters,
      maxCompletionTokens: endpoint.max_completion_tokens,
      reasoningParameterSupported: supportedParameters.includes("reasoning"),
      reasoningEffortVerified: false,
    },
    pricingPerToken,
    variablePricingPresent: variablePricingCount > 0,
    variablePricingDeclared,
    variablePricingCount,
  };
}

export function parseRouterAiRouteArgs(args) {
  const fields = new Map([
    ["--model", "model"],
    ["--upstream", "upstream"],
    ["--country", "country"],
    ["--max-output-tokens", "maxOutputTokens"],
    ["--reasoning-effort", "reasoningEffort"],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const field = fields.get(args[index]),
      value = args[index + 1];
    if (
      !field ||
      Object.hasOwn(options, field) ||
      typeof value !== "string" ||
      value.startsWith("--")
    )
      fail("ROUTERAI_ROUTE_ARGUMENTS_INVALID");
    if (field === "maxOutputTokens") {
      if (!/^[1-9][0-9]{0,9}$/.test(value))
        fail("ROUTERAI_ROUTE_ARGUMENTS_INVALID");
      options[field] = Number(value);
    } else options[field] = value;
  }
  return optionsChecked(options);
}

async function publicCatalog(model, fetchImpl, timeoutMs) {
  if (
    !modelPattern.test(model) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > defaultTimeoutMs
  )
    fail("ROUTERAI_ROUTE_ARGUMENTS_INVALID");
  const url = `${origin}/api/v1/models/${model}/endpoints`;
  const controller = new AbortController();
  let reader;
  let response;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RouteCheckError("ROUTERAI_CATALOG_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    const pending = Promise.resolve()
      .then(() =>
        fetchImpl(url, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        }),
      )
      .then((response) => {
        if (controller.signal.aborted)
          void response.body?.cancel().catch(() => {});
        return response;
      });
    response = await Promise.race([pending, deadline]);
    if (response.redirected || (response.url && response.url !== url))
      fail("ROUTERAI_CATALOG_REDIRECT_REJECTED");
    if (response.status !== 200)
      throw new RouteCheckError(
        "ROUTERAI_CATALOG_HTTP_ERROR",
        Number.isInteger(response.status) &&
          response.status >= 100 &&
          response.status <= 599
          ? response.status
          : undefined,
      );
    const media = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (media !== "application/json")
      fail("ROUTERAI_CATALOG_CONTENT_TYPE_INVALID");
    const declared = response.headers.get("content-length");
    if (declared && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes)
      fail("ROUTERAI_CATALOG_TOO_LARGE");
    if (!response.body) fail();
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0,
      text = "";
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) fail("ROUTERAI_CATALOG_TOO_LARGE");
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      fail();
    }
    return result;
  } catch (error) {
    if (error instanceof RouteCheckError) throw error;
    if (controller.signal.aborted) fail("ROUTERAI_CATALOG_TIMEOUT");
    fail("ROUTERAI_CATALOG_READ_FAILED");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        /* A stalled body may still have a pending read. */
      }
    } else void response?.body?.cancel().catch(() => {});
  }
}

// Injection is for stub-only tests. The executable has no URL/key/env flags.
export async function runRouterAiRouteCheck(
  args,
  {
    fetchImpl = globalThis.fetch,
    writeOut = (value) => process.stdout.write(value),
    writeError = (value) => process.stderr.write(value),
    timeoutMs = defaultTimeoutMs,
  } = {},
) {
  try {
    const options = parseRouterAiRouteArgs(args);
    const catalog = await publicCatalog(options.model, fetchImpl, timeoutMs);
    const result = inspectRouterAiRoute(catalog, options);
    writeOut(JSON.stringify(result, null, 2) + "\n");
    return result.routeMatchesCatalog ? 0 : 2;
  } catch (error) {
    const safe =
      error instanceof RouteCheckError
        ? {
            error: error.code,
            ...(error.httpStatus !== undefined
              ? { httpStatus: error.httpStatus }
              : {}),
          }
        : { error: "ROUTERAI_CATALOG_CHECK_FAILED" };
    writeError(JSON.stringify(safe) + "\n");
    return 3;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await runRouterAiRouteCheck(process.argv.slice(2));
