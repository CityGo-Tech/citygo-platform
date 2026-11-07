import { landingAttributionSchema } from "@citygo/contracts";
import type { LandingAttribution } from "@citygo/contracts";

export const landingCookie = "citygo_landing_attribution";
export const landingIntentCookie = "citygo_landing_intent";
export const landingCookieMaxAge = 60 * 60 * 24 * 30;
export type LandingVersion = "v1" | "v8";
const campaignSlug = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const fields = {
  utm_source: "source",
  utm_medium: "medium",
  utm_campaign: "campaignId",
  utm_content: "content",
} as const;

/** Only operator campaign slugs enter attribution; no term, URL or referrer. */
export function landingAttributionFromSearch(
  landingVersion: LandingVersion,
  search: URLSearchParams,
): LandingAttribution {
  const result: LandingAttribution = { landingVersion };
  for (const [query, field] of Object.entries(fields)) {
    const values = search.getAll(query);
    if (values.length !== 1) continue;
    const value = values[0]!.toLowerCase();
    if (campaignSlug.test(value)) result[field] = value;
  }
  return result;
}

export function parseLandingCookie(
  cookie: string,
): LandingAttribution | undefined {
  if (cookie.length > 16_384) return undefined;
  const values = cookie
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(landingCookie + "="));
  if (values.length !== 1) return undefined;
  try {
    const parsed = landingAttributionSchema.safeParse(
      JSON.parse(
        decodeURIComponent(values[0]!.slice(landingCookie.length + 1)),
      ),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function browserAcquisitionAllowed(): boolean {
  if (typeof window === "undefined") return false;
  if (
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1" ||
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl === true
  )
    return false;
  try {
    return localStorage.getItem("citygo.analytics.optout") !== "1";
  } catch {
    return false;
  }
}

export function readBrowserLandingAttribution():
  LandingAttribution | undefined {
  if (!browserAcquisitionAllowed()) {
    clearBrowserLandingAttribution();
    return undefined;
  }
  try {
    return parseLandingCookie(document.cookie);
  } catch {
    return undefined;
  }
}

export function clearBrowserLandingAttribution(): void {
  try {
    document.cookie = `${landingCookie}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    // Optional acquisition data never controls registration.
  }
}

/** A one-use form preference, independent of optional acquisition tracking. */
export function consumeLandingLoginIntent(): boolean {
  try {
    const login = document.cookie
      .split(";")
      .some((item) => item.trim() === `${landingIntentCookie}=login`);
    document.cookie = `${landingIntentCookie}=; Path=/; Max-Age=0; SameSite=Lax`;
    return login;
  } catch {
    return false;
  }
}

let currentLanding: LandingAttribution | undefined;
export function captureLandingAttribution(
  version: LandingVersion,
): LandingAttribution | undefined {
  if (
    !location.search &&
    currentLanding?.landingVersion === version &&
    browserAcquisitionAllowed()
  )
    return currentLanding;
  currentLanding = browserAcquisitionAllowed()
    ? landingAttributionFromSearch(
        version,
        new URLSearchParams(location.search),
      )
    : undefined;
  return currentLanding;
}

export function landingStartHref(
  productBase: string,
  version: LandingVersion,
  intent: "register" | "login" = "register",
): string {
  const target = new URL("/landing/start", productBase);
  if (intent === "login") target.searchParams.set("intent", "login");
  target.searchParams.set("landing", version);
  const attribution: LandingAttribution =
    browserAcquisitionAllowed() && currentLanding?.landingVersion === version
      ? currentLanding
      : { landingVersion: version };
  for (const [query, field] of Object.entries(fields)) {
    const value = attribution[field];
    if (value) target.searchParams.set(query, value);
  }
  return target.href;
}
