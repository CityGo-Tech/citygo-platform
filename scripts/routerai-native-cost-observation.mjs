const rawNumber = Symbol("raw-json-number");
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new TypeError("Invalid native cost observation");
const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const usageFields = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  input_cached_tokens: "inputCachedTokens",
  output_reasoning_tokens: "outputReasoningTokens",
};

function exactCost(value) {
  if (!record(value) || value[rawNumber] !== true) throw invalid();
  const raw = value.raw;
  if (
    typeof raw !== "string" ||
    raw.length > 80 ||
    !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,30})?$/.test(raw)
  )
    throw invalid();
  const [whole, fraction = ""] = raw.split(".");
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (
    BigInt(whole) > maximum ||
    (BigInt(whole) === maximum && /[1-9]/.test(fraction))
  )
    throw invalid();
  return { jsonType: "number", rawDecimal: raw };
}

function optionalUsage(value) {
  if (value === undefined) return undefined;
  if (!record(value)) throw invalid();
  const selected = {};
  for (const [wire, output] of Object.entries(usageFields)) {
    if (!Object.hasOwn(value, wire)) continue;
    const count = value[wire];
    if (
      !record(count) ||
      count[rawNumber] !== true ||
      typeof count.raw !== "string" ||
      !/^(?:0|[1-9]\d{0,9})$/.test(count.raw) ||
      Number(count.raw) > 1_000_000_000
    )
      throw invalid();
    selected[output] = Number(count.raw);
  }
  if (
    (selected.inputCachedTokens !== undefined &&
      selected.inputTokens !== undefined &&
      selected.inputCachedTokens > selected.inputTokens) ||
    (selected.outputReasoningTokens !== undefined &&
      selected.outputTokens !== undefined &&
      selected.outputReasoningTokens > selected.outputTokens)
  )
    throw invalid();
  return Object.keys(selected).length ? selected : undefined;
}

/** Pure inspection of an already supplied generation JSON response. It performs
 * no transport, environment/key discovery, IO, price arithmetic or charge
 * acceptance. A valid observation is never a customer billing receipt. */
export function inspectRouterAiNativeCostObservation(rawJsonText, expected) {
  try {
    if (
      typeof rawJsonText !== "string" ||
      !rawJsonText.length ||
      loneSurrogate.test(rawJsonText) ||
      Buffer.byteLength(rawJsonText, "utf8") > 65_536 ||
      !record(expected) ||
      typeof expected.generationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(expected.generationId) ||
      typeof expected.reference !== "string" ||
      !uuid.test(expected.reference)
    )
      throw invalid();
    const envelope = JSON.parse(rawJsonText, (key, value, context) => {
      if (typeof value === "string" && loneSurrogate.test(value))
        throw invalid();
      return (key === "total_cost" || Object.hasOwn(usageFields, key)) &&
        typeof value === "number"
        ? { [rawNumber]: true, raw: context?.source }
        : value;
    });
    if (
      !record(envelope) ||
      Object.keys(envelope).length !== 1 ||
      !Object.hasOwn(envelope, "data") ||
      !record(envelope.data)
    )
      throw invalid();
    const data = envelope.data;
    if (
      data.id !== expected.generationId ||
      data.session_id !== expected.reference ||
      data.model !== "openai/gpt-6.1-sol" ||
      data.provider !== "openai" ||
      data.api !== "chat/completions" ||
      data.source !== "api" ||
      data.has_web_search !== true ||
      (data.currency !== undefined && data.currency !== "RUB")
    )
      throw invalid();
    const usage = optionalUsage(data.usage);
    return {
      kind: "routerai-native-cost-observation-v1",
      observationOnly: true,
      identityMatched: true,
      hasWebSearchReported: true,
      totalCost: exactCost(data.total_cost),
      currencyReported: data.currency === "RUB" ? "RUB" : "missing",
      ...(usage ? { usage } : {}),
      billingEligible: false,
      customerReceiptAccepted: false,
      nativeSearchFees: "not-inferred",
      costFinality: "unknown",
    };
  } catch {
    throw invalid();
  }
}
