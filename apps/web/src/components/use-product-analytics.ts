"use client";
import { useEffect, useRef } from "react";
import { clearBrowserLandingAttribution } from "./landing/landing-attribution";
import { customerInteractionNameSchema } from "@citygo/contracts";
import type { CustomerInteractionName } from "@citygo/contracts";
import {
  analyticsLocationAllowed,
  analyticsReferrerAllowed,
  connectProductAnalytics,
  contentFreeParams,
  createPendingProductEvents,
  createRegistrationProductFlow,
  createProductAnalytics,
  isAnalyticsIdentity,
  type AnalyticsSurface,
  type ProductAnalyticsConfig,
  type YandexMetrika,
  type RegistrationAnalyticsFlow,
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
let scriptReady: Promise<YandexMetrika | null> | null = null;
let scriptExecuted = false;

/** No invisible fallback pixel and no automatic retry of a blocked collector. */
function loadMetrika(): Promise<YandexMetrika | null> {
  if (scriptFailed || (window.ym && typeof window.ym !== "function"))
    return Promise.resolve(null);
  if (scriptReady) return scriptReady;
  if (!window.ym) {
    const stub: YandexMetrika = (id, method, ...args) => {
      const queue = (stub.a ??= []);
      if (queue.length < 100) queue.push([id, method, ...args]);
    };
    stub.l = Date.now();
    window.ym = stub;
    ownStub = stub;
  }
  scriptReady = new Promise((resolve) => {
    if (scriptAttempted) {
      resolve(null);
      return;
    }
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
      resolve(null);
    };
    // Do not put commands for an unverified owner in the SDK's global stub.
    // Our per-lifetime queue waits until the downloaded script has executed.
    script.onload = () => {
      scriptExecuted = true;
      resolve(
        typeof window.ym === "function"
          ? (id, method, ...args) => window.ym?.(id, method, ...args)
          : null,
      );
    };
    document.head.append(script);
  });
  return scriptReady;
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
    if (value) clearBrowserLandingAttribution();
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
  dashboard(): Promise<{
    user: {
      id: string;
      role?: string;
      mustChangePassword?: boolean;
      serviceConsentRequired?: boolean;
    };
  }>;
};

type AuthSuccess = "registration_completed" | "login_completed";
type AuthReceipt = {
  event: AuthSuccess;
  ownerId: string;
  signal: AbortSignal;
  onceKey: string;
  at: number;
  cancel: () => void;
  landingVersion?: "v1" | "v8";
};

function transientIdentityFailure(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  return (
    status === undefined ||
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
}

/** The hook is mounted only by Home; admin/auth API routes never load a tag. */
export function useProductAnalytics(options: {
  config: ProductAnalyticsConfig;
  ownerId: string | null;
  role?: string;
  blocked: boolean;
  surface: AnalyticsSurface;
  sessionSignal: AbortSignal;
  client: AnalyticsClient;
  publicLandingVersion?: "v1" | "v8";
}) {
  const { config, ownerId, role, blocked, sessionSignal, client } = options;
  const surface = useRef(options.surface);
  surface.current = options.surface;
  const recorder = useRef<ReturnType<typeof createProductAnalytics> | null>(
    null,
  );
  const authReceipt = useRef<AuthReceipt | null>(null);
  const publishAuth = useRef<() => void>(() => {});
  const registrationFlow = useRef(createRegistrationProductFlow()).current;
  function clearAuth() {
    const receipt = authReceipt.current;
    if (receipt) receipt.signal.removeEventListener("abort", receipt.cancel);
    authReceipt.current = null;
  }
  useEffect(() => {
    const receipt = authReceipt.current;
    if (
      receipt &&
      (receipt.signal !== sessionSignal ||
        receipt.signal.aborted ||
        Date.now() - receipt.at >= 120_000 ||
        (ownerId !== null && (receipt.ownerId !== ownerId || role !== "user")))
    ) {
      clearAuth();
      registrationFlow.clear();
    }
    if (
      blocked ||
      sessionSignal.aborted ||
      (ownerId !== null && role !== "user") ||
      browserAnalyticsOptedOut()
    )
      return;
    let disposed = false;
    let suspended = false;
    let generation = 0;
    let starting = false;
    let landingSent = false;
    let current: ReturnType<typeof createProductAnalytics> | null = null;
    const pending = createPendingProductEvents();
    const active = () =>
      !disposed &&
      !suspended &&
      !sessionSignal.aborted &&
      !browserAnalyticsOptedOut();
    const externalAllowed = () =>
      active() &&
      config.enabled &&
      analyticsLocationAllowed(window.location) &&
      analyticsReferrerAllowed(document.referrer) &&
      (privateDomMasked() ||
        (!!options.publicLandingVersion &&
          window.location.pathname ===
            "/landing/" + options.publicLandingVersion &&
          !!document.querySelector(
            `[data-citygo-public-landing="${options.publicLandingVersion}"]`,
          ) &&
          !document.querySelector(
            "form, input, textarea, [contenteditable=true]",
          )));
    const sendPending = () => {
      if (!current || !externalAllowed()) return;
      pending.drain((event, params, onceKey) => {
        if (!current || !externalAllowed()) return;
        const sent = current.event(event, params, onceKey);
        if (params?.surface) current.view(params.surface);
        if (sent) registrationFlow.submitted(onceKey);
        if (sent && authReceipt.current?.onceKey === onceKey) {
          clearAuth();
          registrationFlow.clear();
        }
      });
    };
    const publishReceipt = () => {
      if (!externalAllowed()) return;
      const value = authReceipt.current;
      if (
        value &&
        ownerId !== null &&
        (value.signal !== sessionSignal ||
          value.signal.aborted ||
          value.ownerId !== ownerId ||
          role !== "user" ||
          Date.now() - value.at >= 120_000 ||
          browserAnalyticsOptedOut())
      ) {
        pending.discard(value.onceKey);
        for (const stage of registrationFlow.pending(sessionSignal, ownerId))
          pending.discard(stage.onceKey);
        clearAuth();
        registrationFlow.clear();
        return;
      }
      for (const stage of registrationFlow.pending(sessionSignal, ownerId))
        pending.add(
          stage.event,
          {
            surface: "register",
            ...(stage.landingVersion
              ? { landingVersion: stage.landingVersion }
              : {}),
          },
          stage.onceKey,
        );
      if (!value || ownerId === null) {
        sendPending();
        return;
      }
      pending.add(
        value.event,
        {
          surface:
            value.event === "registration_completed" ? "register" : "login",
          ...(value.landingVersion
            ? { landingVersion: value.landingVersion }
            : {}),
        },
        value.onceKey,
      );
      sendPending();
    };
    publishAuth.current = publishReceipt;
    // Optional UI milestones are first-party, content-free and current-session
    // bound. Payments/replies/gifts remain authoritative server domain data.
    const disconnect = connectProductAnalytics((event, params, onceKey) => {
      if (!active()) return;
      const clean = contentFreeParams(params ?? {});
      if (!clean) return;
      if (externalAllowed()) {
        pending.add(event, clean, onceKey);
        sendPending();
      }
      const input = customerInteractionNameSchema.safeParse(event);
      if (ownerId !== null && input.success)
        void client.recordProductEvent(input.data).catch(() => {});
    });
    function stop() {
      generation++;
      starting = false;
      current?.stop();
      if (recorder.current === current) recorder.current = null;
      current = null;
      pending.clear();
      // Pending bootstrap commands cannot revive a departed account/route.
      if (!scriptExecuted && window.ym === ownStub && ownStub) ownStub.a = [];
    }
    const onPrivacyOrLocation = () => {
      if (
        browserAnalyticsOptedOut() ||
        !analyticsLocationAllowed(window.location)
      ) {
        clearAuth();
        registrationFlow.clear();
        stop();
      }
    };
    const onAbort = () => {
      disposed = true;
      clearAuth();
      disconnect();
      stop();
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        onAbort();
        return;
      }
      suspended = true;
      stop();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || disposed || sessionSignal.aborted) return;
      // UI and first-party events stay suspended until the cookie/session is
      // checked too. Otherwise a click in the restored old UI could be written
      // under a different account while this GET is still pending.
      suspended = true;
      stop();
      const version = generation;
      if (browserAnalyticsOptedOut()) return;
      void sameSessionAfterRestore().then((same) => {
        if (disposed || sessionSignal.aborted || version !== generation) return;
        if (!same || browserAnalyticsOptedOut()) {
          clearAuth();
          registrationFlow.clear();
          stop();
          return;
        }
        suspended = false;
        void bootstrap();
      });
    };
    async function sameSessionAfterRestore() {
      try {
        const board = await client.dashboard();
        return (
          ownerId !== null &&
          board.user.id === ownerId &&
          board.user.role === "user" &&
          !board.user.mustChangePassword &&
          !board.user.serviceConsentRequired
        );
      } catch (error) {
        return (
          ownerId === null &&
          !!error &&
          typeof error === "object" &&
          "status" in error &&
          error.status === 401
        );
      }
    }
    async function bootstrap() {
      if (!externalAllowed() || starting || current) return;
      starting = true;
      const version = ++generation;
      const valid = () => version === generation && externalAllowed();
      try {
        let identity: string | null = null;
        if (ownerId !== null) {
          for (let attempt = 0; attempt < 2; attempt++) {
            if (!valid()) return;
            try {
              identity = (await client.analyticsIdentity()).analyticsUserId;
              if (identity !== null && !isAnalyticsIdentity(identity)) return;
              break;
            } catch (error) {
              if (attempt === 1 || !transientIdentityFailure(error)) return;
              await new Promise<void>((resolve) => setTimeout(resolve, 250));
            }
          }
        }
        if (!valid()) return;
        const send = await loadMetrika();
        if (!send || !valid()) return;
        current = createProductAnalytics(
          config,
          send,
          window.location,
          options.publicLandingVersion,
        );
        if (!current.start(identity)) {
          current = null;
          return;
        }
        recorder.current = current;
        current.view(surface.current);
        if (ownerId === null && !landingSent)
          landingSent = current.event(
            "landing_viewed",
            { surface: "landing" },
            "visit",
          );
        publishReceipt();
        sendPending();
      } catch {
        // Optional diagnostics cannot interrupt the user's operation.
      } finally {
        if (version === generation) starting = false;
      }
    }
    window.addEventListener("storage", onPrivacyOrLocation);
    window.addEventListener(preferenceEvent, onPrivacyOrLocation);
    window.addEventListener("popstate", onPrivacyOrLocation);
    window.addEventListener("hashchange", onPrivacyOrLocation);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    sessionSignal.addEventListener("abort", onAbort, { once: true });
    publishReceipt();
    void bootstrap();
    return () => {
      disposed = true;
      disconnect();
      stop();
      if (publishAuth.current === publishReceipt)
        publishAuth.current = () => {};
      sessionSignal.removeEventListener("abort", onAbort);
      window.removeEventListener("storage", onPrivacyOrLocation);
      window.removeEventListener(preferenceEvent, onPrivacyOrLocation);
      window.removeEventListener("popstate", onPrivacyOrLocation);
      window.removeEventListener("hashchange", onPrivacyOrLocation);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
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
    registrationFlow,
    options.publicLandingVersion,
  ]);
  useEffect(() => {
    recorder.current?.view(options.surface);
  }, [options.surface]);
  return {
    beginRegistration(signal: AbortSignal, landingVersion?: "v1" | "v8") {
      if (signal.aborted || browserAnalyticsOptedOut() || !config.enabled)
        return null;
      const flow = registrationFlow.begin(signal, landingVersion);
      publishAuth.current();
      return flow;
    },
    registrationCodeSent(
      flow: RegistrationAnalyticsFlow | null,
      challengeId: string,
      signal: AbortSignal,
    ) {
      registrationFlow.codeSent(flow, challengeId, signal);
      publishAuth.current();
    },
    prepareRegistrationSuccess(
      flow: RegistrationAnalyticsFlow | null,
      user: { id: string; role?: string },
      signal: AbortSignal,
      challengeId?: string,
    ) {
      return registrationFlow.prepare(flow, user, signal, challengeId);
    },
    authSuccess(
      event: AuthSuccess,
      user: { id: string; role?: string },
      signal: AbortSignal,
      flow?: RegistrationAnalyticsFlow | null,
    ) {
      clearAuth();
      if (
        !["registration_completed", "login_completed"].includes(event) ||
        user.role !== "user" ||
        !/^[1-9][0-9]{0,17}$/.test(user.id) ||
        signal.aborted ||
        browserAnalyticsOptedOut() ||
        !config.enabled
      ) {
        registrationFlow.clear();
        return;
      }
      if (flow) registrationFlow.transfer(flow, user.id, signal);
      else registrationFlow.clear();
      const value: AuthReceipt = {
        event,
        ...(event === "registration_completed" &&
        flow &&
        registrationFlow.landingVersion(flow)
          ? { landingVersion: registrationFlow.landingVersion(flow) }
          : {}),
        ownerId: user.id,
        signal,
        at: Date.now(),
        onceKey: "auth:" + crypto.randomUUID(),
        cancel: () => {
          if (authReceipt.current === value) clearAuth();
        },
      };
      authReceipt.current = value;
      signal.addEventListener("abort", value.cancel, { once: true });
      publishAuth.current();
    },
  };
}
