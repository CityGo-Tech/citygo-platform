import type { HousingWorkspaceCriteria } from "@citygo/contracts";

export type HousingShortlistListing = {
  id: string;
  url: string;
  title: string;
  city: string;
  district: string;
  rentRub: number | null;
};
export type HousingShortlistSnapshot = {
  capturedAt: string;
  complete: boolean;
  listings: readonly HousingShortlistListing[];
};
export type HousingShortlistOffer = HousingShortlistListing & {
  originalId: string;
  lastSeenAt: string;
};

const day = 24 * 60 * 60 * 1000;
const originalPrefix = "https://rent.example/offer/";

function originalId(url: string) {
  if (!url.startsWith(originalPrefix)) return null;
  const id = url.slice(originalPrefix.length);
  return /^[a-z0-9-]{1,50}$/.test(id) && id.trim() === id ? id : null;
}

/** Materialize accepted snapshots from a single, manual fixture source. */
export function projectHousingShortlist(
  snapshots: readonly HousingShortlistSnapshot[],
  now: number,
): HousingShortlistOffer[] {
  let acceptedAt = -Infinity;
  let seen = new Map<string, HousingShortlistOffer>();
  for (const snapshot of snapshots) {
    const capture = Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(capture) || capture > now || capture <= acceptedAt)
      continue;
    const next = snapshot.complete
      ? new Map<string, HousingShortlistOffer>()
      : new Map(seen);
    let valid = true;
    for (const listing of snapshot.listings) {
      const id = originalId(listing.url);
      if (!id) {
        valid = false;
        break;
      }
      next.set(listing.id, {
        ...listing,
        originalId: id,
        lastSeenAt: snapshot.capturedAt,
      });
    }
    // An unusable complete snapshot cannot withdraw previously seen offers.
    if (!valid) continue;
    seen = next;
    acceptedAt = capture;
  }

  const newestFirst = Array.from(seen.values())
    .filter((offer) => now - Date.parse(offer.lastSeenAt) < day)
    .sort(
      (a, b) =>
        Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) ||
        a.id.localeCompare(b.id, "en"),
    );

  const unique = new Map<string, HousingShortlistOffer>();
  for (const offer of newestFirst)
    if (!unique.has(offer.originalId)) unique.set(offer.originalId, offer);
  return Array.from(unique.values());
}

function place(value: string) {
  return value.normalize("NFC").trim().toLocaleLowerCase("ru-RU");
}

export function selectHousingShortlist(
  offers: readonly HousingShortlistOffer[],
  criteria: Pick<HousingWorkspaceCriteria, "city" | "budgetRub">,
): { offer: HousingShortlistOffer; matches: ("city" | "budget")[] }[] {
  const city = place(criteria.city);
  if (!city) return [];
  const budget = criteria.budgetRub;
  return offers
    .filter(
      (offer) =>
        place(offer.city) === city &&
        (budget === null ||
          (offer.rentRub !== null && offer.rentRub <= budget)),
    )
    .slice(0, 3)
    .map((offer) => ({
      offer,
      matches: budget === null ? ["city"] : ["city", "budget"],
    }));
}

export function isHousingShortlistLoopback(host: string): boolean {
  return (
    host.trim() === host &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host)
  );
}
