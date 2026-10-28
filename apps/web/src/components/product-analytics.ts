/** Explicit, content-free product analytics. The default is no collection. */
export const productEvents = [
  "landing_viewed",
  "registration_started",
  "registration_code_sent",
  "registration_completed",
  "registration_failed",
  "login_completed",
  "login_failed",
  "logout_completed",
  "assistant_opened",
  "conversation_opened",
  "ai_request_submitted",
  "ai_response_completed",
  "ai_response_failed",
  "ai_response_stopped",
  "mode_selected",
  "favorite_added",
  "favorite_removed",
  "phone_code_sent",
  "phone_verified",
  "gift_granted",
  "wallet_opened",
  "phone_opened",
  "profile_opened",
  "plan_opened",
  "payment_created",
  "payment_redirected",
  "payment_credited",
  "payment_canceled",
  "payment_review_required",
] as const;
export type ProductEvent = (typeof productEvents)[number];
export const analyticsSurfaces = [
  "landing",
  "register",
  "login",
  "chat",
  "wallet",
  "phone",
  "profile",
  "plan",
  "favorites",
] as const;
export type AnalyticsSurface = (typeof analyticsSurfaces)[number];
const modes = ["maximum", "balanced", "minimum"];
const assistants = [
  "housing",
  "job-search",
  "resume-builder",
  "digital-mentor",
  "support",
] as const;
export type ProductEventParams = {
  surface?: AnalyticsSurface;
  mode?: "maximum" | "balanced" | "minimum";
  assistant?: (typeof assistants)[number];
};
export type ProductAnalyticsConfig = {
  enabled: boolean;
  counterId: number | null;
  webvisor: boolean;
};
export type AnalyticsLocation = {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
};
export type YandexMetrika = ((
  counterId: number,
  method: string,
  ...args: unknown[]
) => void) & { a?: unknown[][]; l?: number };

export function parseProductAnalyticsConfig(value: {
  enabled?: string;
  counterId?: string;
  webvisor?: string;
}): ProductAnalyticsConfig {
  const counterId =
    typeof value.counterId === "string" &&
    /^[1-9][0-9]{0,9}$/.test(value.counterId) &&
    Number.isSafeInteger(Number(value.counterId))
      ? Number(value.counterId)
      : null;
  return {
    enabled: value.enabled === "enabled" && counterId !== null,
    counterId,
    webvisor: value.webvisor === "enabled",
  };
}

/** Only the known, query-free Home route can contain the recorder. */
export function analyticsLocationAllowed(value: AnalyticsLocation): boolean {
  return (
    [
      "https://pilot.xn--c1ajazlh.xn--p1ai",
      "https://app.xn--c1ajazlh.xn--p1ai",
      "https://xn--c1ajazlh.xn--p1ai",
    ].includes(value.origin) &&
    value.pathname === "/" &&
    value.search === "" &&
    value.hash === ""
  );
}

/** The SDK can inspect document.referrer itself; never load it on private URLs. */
export function analyticsReferrerAllowed(value: string): boolean {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && analyticsLocationAllowed(url);
  } catch {
    return false;
  }
}

export function contentFreeParams(value: unknown): ProductEventParams | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["surface", "mode", "assistant"].includes(key),
    )
  )
    return null;
  const params = value as Record<string, unknown>;
  if (
    (params.surface !== undefined &&
      !analyticsSurfaces.includes(params.surface as AnalyticsSurface)) ||
    (params.mode !== undefined && !modes.includes(params.mode as string)) ||
    (params.assistant !== undefined &&
      !assistants.includes(params.assistant as (typeof assistants)[number]))
  )
    return null;
  // Construct a new allowlisted record; never copy extra/symbol properties.
  const clean: ProductEventParams = {};
  if (params.surface !== undefined)
    clean.surface = params.surface as AnalyticsSurface;
  if (params.mode !== undefined)
    clean.mode = params.mode as ProductEventParams["mode"];
  if (params.assistant !== undefined)
    clean.assistant = params.assistant as ProductEventParams["assistant"];
  return clean;
}

export function isAnalyticsIdentity(value: unknown): value is string {
  return typeof value === "string" && /^cga_[a-f0-9]{64}$/.test(value);
}

/** Never start a collector from a stale identity lookup or revoked preference. */
export async function whenAnalyticsIdentityReady(
  identity: () => Promise<string | null>,
  allowed: () => boolean,
  start: (value: string | null) => void,
): Promise<void> {
  if (!allowed()) return;
  try {
    const value = await identity();
    if (!allowed() || (value !== null && !isAnalyticsIdentity(value))) return;
    start(value);
  } catch {
    // Authentication, storage, script and collector failures are optional.
  }
}

export function createProductAnalytics(
  config: ProductAnalyticsConfig,
  send: YandexMetrika,
  location: AnalyticsLocation,
) {
  let active = false;
  let surface: AnalyticsSurface | null = null;
  const seen = new Set<string>();
  function call(method: string, ...args: unknown[]): boolean {
    if (!active || !config.counterId) return false;
    try {
      send(config.counterId, method, ...args);
      return true;
    } catch {
      // Analytics/ad blockers cannot turn a successful app action into failure.
      return false;
    }
  }
  return {
    start(identity: string | null = null): boolean {
      if (active) return true;
      if (
        !config.enabled ||
        !config.counterId ||
        !Number.isSafeInteger(config.counterId) ||
        config.counterId < 1 ||
        !analyticsLocationAllowed(location) ||
        (identity !== null && !isAnalyticsIdentity(identity))
      )
        return false;
      active = true;
      if (
        !call("init", {
          defer: true,
          clickmap: true,
          trackLinks: false,
          trackHash: false,
          childIframe: false,
          ecommerce: false,
          disableYtm: true,
          sendTitle: false,
          accurateTrackBounce: true,
          webvisor: config.webvisor,
        })
      ) {
        active = false;
        return false;
      }
      if (identity !== null) call("setUserID", identity);
      return true;
    },
    view(next: AnalyticsSurface): boolean {
      if (!analyticsSurfaces.includes(next) || !active || next === surface)
        return false;
      const sent = call("hit", location.origin + "/", {
        title: "CityGo",
        referer: "",
        params: { surface: next },
      });
      if (sent) surface = next;
      return sent;
    },
    event(
      name: ProductEvent,
      value: ProductEventParams = {},
      onceKey?: string,
    ): boolean {
      const params = contentFreeParams(value);
      if (!active || !productEvents.includes(name) || params === null)
        return false;
      // Correlation keys are memory-only and are NEVER sent to the collector.
      const key = onceKey === undefined ? null : name + ":" + onceKey;
      if (key !== null && (key.length > 200 || seen.has(key))) return false;
      const sent = call("reachGoal", "citygo_" + name, params);
      if (sent && key !== null) {
        if (seen.size >= 200) seen.delete(seen.values().next().value!);
        seen.add(key);
      }
      return sent;
    },
    stop() {
      if (active) call("destruct");
      active = false;
      surface = null;
      seen.clear();
    },
  };
}

export type ProductEventSink = (
  event: ProductEvent,
  params?: ProductEventParams,
  onceKey?: string,
) => void;
let sink: ProductEventSink | null = null;
export function connectProductAnalytics(next: ProductEventSink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}
/** No sink is present during SSR, admin pages, disabled config or unmount. */
export function trackProductEvent(
  event: ProductEvent,
  params?: ProductEventParams,
  onceKey?: string,
): void {
  try {
    sink?.(event, params, onceKey);
  } catch {
    /* Telemetry never owns the lifecycle of an app action. */
  }
}
