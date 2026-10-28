"use client";
import { useEffect, useRef } from "react";
import { customerInteractionNameSchema } from "@citygo/contracts";
import type { CustomerInteractionName } from "@citygo/contracts";
import {
  analyticsLocationAllowed,
  analyticsReferrerAllowed,
  connectProductAnalytics,
  contentFreeParams,
  createProductAnalytics,
  whenAnalyticsIdentityReady,
  type AnalyticsSurface,
  type ProductAnalyticsConfig,
  type YandexMetrika,
} from "./product-analytics";

declare global {
  interface Window {
    ym?: YandexMetrika;
    doNotTrack?: string;
  }
}
const scriptId = "citygo-yandex-metrika";
const preferenceEvent = "citygo:analytics-preference";
let scriptAttempted = false;
let scriptFailed = false;
let ownStub: YandexMetrika | null = null;

/** No invisible fallback pixel and no automatic retry of a blocked collector. */
function loadMetrika(): YandexMetrika | null {
  if (scriptFailed || (window.ym && typeof window.ym !== "function"))
    return null;
  if (!window.ym) {
    const stub: YandexMetrika = (id, method, ...args) => {
      const queue = (stub.a ??= []);
      if (queue.length < 100) queue.push([id, method, ...args]);
    };
    stub.l = Date.now();
    window.ym = stub;
    ownStub = stub;
  }
  if (!scriptAttempted) {
    scriptAttempted = true;
    const script = document.createElement("script");
    script.id = scriptId;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.src = "https://mc.yandex.ru/metrika/tag.js";
    script.onerror = () => {
      scriptFailed = true;
      if (window.ym === ownStub && ownStub) ownStub.a = [];
      script.remove();
    };
    document.head.append(script);
  }
  return (id, method, ...args) => window.ym?.(id, method, ...args);
}

export function browserAnalyticsOptedOut(): boolean {
  if (
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1" ||
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl === true
  )
    return true;
  try {
    return window.localStorage.getItem("citygo.analytics.optout") === "1";
  } catch {
    return true;
  }
}

/** Can be used by the legal page without introducing a registration checkbox. */
export function setBrowserAnalyticsOptOut(value: boolean): void {
  try {
    if (value) window.localStorage.setItem("citygo.analytics.optout", "1");
    else window.localStorage.removeItem("citygo.analytics.optout");
  } catch {
    // Unavailable storage already opts out; a privacy action cannot break UI.
  } finally {
    window.dispatchEvent(new Event(preferenceEvent));
  }
}

export function privateDomMasked(): boolean {
  return !!document.querySelector(
    "main[data-citygo-analytics-private].ym-hide-content",
  );
}

type AnalyticsClient = {
  analyticsIdentity(): Promise<{ analyticsUserId: string | null }>;
  recordProductEvent(event: CustomerInteractionName): Promise<unknown>;
};

/** The hook is mounted only by Home; admin/auth API routes never load a tag. */
export function useProductAnalytics(options: {
  config: ProductAnalyticsConfig;
  ownerId: string | null;
  role?: string;
  blocked: boolean;
  surface: AnalyticsSurface;
  sessionSignal: AbortSignal;
  client: AnalyticsClient;
}) {
  const { config, ownerId, role, blocked, sessionSignal, client } = options;
  const surface = useRef(options.surface);
  surface.current = options.surface;
  const recorder = useRef<ReturnType<typeof createProductAnalytics> | null>(
    null,
  );
  useEffect(() => {
    if (
      blocked ||
      sessionSignal.aborted ||
      (ownerId !== null && role !== "user") ||
      browserAnalyticsOptedOut()
    )
      return;
    let disposed = false;
    let current: ReturnType<typeof createProductAnalytics> | null = null;
    const active = () =>
      !disposed && !sessionSignal.aborted && !browserAnalyticsOptedOut();
    // Optional UI milestones are first-party, content-free and current-session
    // bound. Payments/replies/gifts remain authoritative server domain data.
    const disconnect = connectProductAnalytics((event, params, onceKey) => {
      if (!active()) return;
      const clean = contentFreeParams(params ?? {});
      if (!clean) return;
      current?.event(event, clean, onceKey);
      if (clean.surface) current?.view(clean.surface);
      const input = customerInteractionNameSchema.safeParse(event);
      if (ownerId !== null && input.success)
        void client.recordProductEvent(input.data).catch(() => {});
    });
    function stop() {
      current?.stop();
      if (recorder.current === current) recorder.current = null;
      current = null;
      // Pending bootstrap commands cannot revive a departed account/route.
      if (window.ym === ownStub && ownStub) ownStub.a = [];
    }
    const externalAllowed = () =>
      active() &&
      config.enabled &&
      analyticsLocationAllowed(window.location) &&
      analyticsReferrerAllowed(document.referrer) &&
      privateDomMasked();
    const onPrivacyOrLocation = () => {
      if (
        browserAnalyticsOptedOut() ||
        !analyticsLocationAllowed(window.location)
      )
        stop();
    };
    const onAbort = () => {
      disposed = true;
      disconnect();
      stop();
    };
    window.addEventListener("storage", onPrivacyOrLocation);
    window.addEventListener(preferenceEvent, onPrivacyOrLocation);
    window.addEventListener("popstate", onPrivacyOrLocation);
    window.addEventListener("hashchange", onPrivacyOrLocation);
    window.addEventListener("pagehide", onAbort);
    sessionSignal.addEventListener("abort", onAbort, { once: true });
    void whenAnalyticsIdentityReady(
      async () =>
        ownerId === null
          ? null
          : (await client.analyticsIdentity()).analyticsUserId,
      externalAllowed,
      (identity) => {
        // Sensitive DOM is already masked in the initial React/SSR markup.
        const send = loadMetrika();
        if (!send) return;
        current = createProductAnalytics(config, send, window.location);
        if (!current.start(identity)) return;
        recorder.current = current;
        current.view(surface.current);
        if (ownerId === null)
          current.event("landing_viewed", { surface: "landing" }, "visit");
      },
    );
    return () => {
      disposed = true;
      disconnect();
      stop();
      sessionSignal.removeEventListener("abort", onAbort);
      window.removeEventListener("storage", onPrivacyOrLocation);
      window.removeEventListener(preferenceEvent, onPrivacyOrLocation);
      window.removeEventListener("popstate", onPrivacyOrLocation);
      window.removeEventListener("hashchange", onPrivacyOrLocation);
      window.removeEventListener("pagehide", onAbort);
    };
  }, [
    config.enabled,
    config.counterId,
    config.webvisor,
    ownerId,
    role,
    blocked,
    sessionSignal,
    client,
  ]);
  useEffect(() => {
    recorder.current?.view(options.surface);
  }, [options.surface]);
}
