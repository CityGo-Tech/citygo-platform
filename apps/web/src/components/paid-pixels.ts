import { landingAttributionSchema } from "@citygo/contracts";

/** Public advertising counters. No credentials, identity or application content. */
export type PaidPixelConfig = {
  enabled: boolean;
  vkPixelId: number | null;
  avitoCounterId: number | null;
};

function publicId(value?: string): number | null {
  return value && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;
}

export function parsePaidPixelConfig(value: {
  enabled?: string;
  vkPixelId?: string;
  avitoCounterId?: string;
}): PaidPixelConfig {
  const vkPixelId = publicId(value.vkPixelId);
  const avitoCounterId = publicId(value.avitoCounterId);
  return {
    enabled: value.enabled === "enabled" && !!(vkPixelId || avitoCounterId),
    vkPixelId,
    avitoCounterId,
  };
}

/** Operator campaign labels only; this is not a filter for personal data. */
export function paidPixelUrlAllowed(value: string, origin: string): boolean {
  try {
    if (value.length > 1024) return false;
    const url = new URL(value);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      !["/", "/landing/v1", "/landing/v8"].includes(url.pathname)
    )
      return false;
    const allowed = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
    const seen = new Set<string>();
    for (const [key, label] of url.searchParams) {
      if (
        !allowed.includes(key) ||
        seen.has(key) ||
        !landingAttributionSchema.shape.source.safeParse(label).success
      )
        return false;
      seen.add(key);
    }
    return true;
  } catch {
    return false;
  }
}

/** SDKs own a disposable child document, never the product's DOM/history.
 * Same-origin permits their normal cookie/history APIs; this is a lifetime
 * boundary for approved provider code, not a malicious-code security sandbox.
 */
export function createPaidPixelBridge(
  config: PaidPixelConfig,
  url: string,
  host: Window = window,
) {
  let frame: HTMLIFrameElement | null = null;
  let active = false;
  let ready = false;
  let registrationPending = false;
  let registrationSent = false;
  const seen = new Set<string>();
  const channel = host.crypto.randomUUID();
  const validId = (value: number | null) =>
    value === null ||
    (Number.isSafeInteger(value) && value > 0 && value < 10_000_000_000);
  function sendRegistration() {
    if (!active || !ready || !registrationPending || registrationSent) return;
    try {
      frame?.contentWindow?.postMessage(
        { type: "citygo-paid-registration", version: 1, channel },
        host.location.origin,
      );
      registrationSent = true;
      registrationPending = false;
    } catch {
      // A disabled/blocked collector must not fail an account operation.
    }
  }
  const onMessage = (event: MessageEvent) => {
    if (
      !active ||
      !frame?.contentWindow ||
      event.source !== frame.contentWindow ||
      event.origin !== host.location.origin ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data) ||
      Object.keys(event.data).sort().join(",") !== "channel,type,version" ||
      event.data.type !== "citygo-paid-ready" ||
      event.data.version !== 1 ||
      event.data.channel !== channel
    )
      return;
    ready = true;
    sendRegistration();
  };
  return {
    start(): boolean {
      if (active) return true;
      if (
        !config.enabled ||
        !(config.vkPixelId || config.avitoCounterId) ||
        !validId(config.vkPixelId) ||
        !validId(config.avitoCounterId) ||
        !paidPixelUrlAllowed(url, host.location.origin)
      )
        return false;
      try {
        active = true;
        frame = host.document.createElement("iframe");
        frame.hidden = true;
        frame.title = "CityGo advertising measurement";
        frame.setAttribute("data-citygo-paid-pixels", "");
        frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
        frame.referrerPolicy = "no-referrer";
        frame.src = "/paid-pixels/frame.html";
        frame.onload = () => {
          if (!active) return;
          try {
            frame?.contentWindow?.postMessage(
              {
                type: "citygo-paid-init",
                version: 1,
                channel,
                url,
                config: {
                  vkPixelId: config.vkPixelId,
                  avitoCounterId: config.avitoCounterId,
                },
              },
              host.location.origin,
            );
          } catch {
            // Fail closed; no top-document or image fallback.
          }
        };
        host.addEventListener("message", onMessage);
        host.document.body.append(frame);
        return true;
      } catch {
        frame?.remove();
        frame = null;
        active = false;
        host.removeEventListener("message", onMessage);
        return false;
      }
    },
    registrationCompleted(onceKey: string): boolean {
      if (
        !active ||
        typeof onceKey !== "string" ||
        !onceKey ||
        onceKey.length > 200 ||
        seen.has(onceKey)
      )
        return false;
      if (seen.size >= 100) return false;
      seen.add(onceKey);
      registrationPending = true;
      sendRegistration();
      return true;
    },
    stop() {
      active = false;
      ready = false;
      registrationPending = false;
      host.removeEventListener("message", onMessage);
      if (frame) frame.onload = null;
      frame?.remove();
      frame = null;
      seen.clear();
    },
  };
}
