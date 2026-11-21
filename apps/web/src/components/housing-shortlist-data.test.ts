import assert from "node:assert/strict";
import test from "node:test";
import {
  isHousingShortlistLoopback,
  projectHousingShortlist,
  selectHousingShortlist,
  type HousingShortlistListing,
  type HousingShortlistSnapshot,
} from "./housing-shortlist-data";

const start = "2026-11-20T09:00:00.000Z";
const updated = "2026-11-20T10:00:00.000Z";
const now = Date.parse("2026-11-20T11:00:00.000Z");

function listing(
  id: string,
  overrides: Partial<HousingShortlistListing> = {},
): HousingShortlistListing {
  return {
    id,
    url: `https://rent.example/offer/${id}`,
    title: `Тестовая квартира ${id}`,
    city: "Москва",
    district: "Текстильщики",
    rentRub: 55_000,
    ...overrides,
  };
}

function snapshot(
  capturedAt: string,
  complete: boolean,
  ...listings: HousingShortlistListing[]
): HousingShortlistSnapshot {
  return { capturedAt, complete, listings };
}

test("a complete snapshot withdraws missing listings and advances the observation of listings still present", () => {
  const present = listing("flat-a");
  const withdrawn = listing("flat-b");
  const offers = projectHousingShortlist(
    [
      snapshot(start, true, present, withdrawn),
      snapshot(updated, true, present),
    ],
    now,
  );

  assert.deepEqual(
    offers.map(({ originalId, lastSeenAt }) => [originalId, lastSeenAt]),
    [["flat-a", updated]],
  );
});

test("a partial snapshot leaves missing listings at their own observation time and TTL expires at 24 hours", () => {
  const snapshots = [
    snapshot(start, true, listing("flat-a"), listing("flat-b")),
    snapshot(updated, false, listing("flat-a")),
  ];
  const expiration = Date.parse("2026-11-21T09:00:00.000Z");
  const beforeExpiration = projectHousingShortlist(snapshots, expiration - 1);

  assert.deepEqual(
    new Map(
      beforeExpiration.map(({ originalId, lastSeenAt }) => [
        originalId,
        lastSeenAt,
      ]),
    ),
    new Map([
      ["flat-a", updated],
      ["flat-b", start],
    ]),
  );
  assert.deepEqual(
    projectHousingShortlist(snapshots, expiration).map(
      ({ originalId }) => originalId,
    ),
    ["flat-a"],
  );
});

test("older or same-timestamp snapshots cannot withdraw, overwrite, or extend fresh offers", () => {
  const saved = listing("flat-a");
  const offers = projectHousingShortlist(
    [
      snapshot(updated, true, saved),
      snapshot(start, true),
      snapshot(updated, true, { ...saved, rentRub: 1 }),
    ],
    now,
  );

  assert.deepEqual(
    offers.map(({ originalId, rentRub, lastSeenAt }) => [
      originalId,
      rentRub,
      lastSeenAt,
    ]),
    [["flat-a", saved.rentRub, updated]],
  );
});

test("duplicated original URL appears once and uses the most recent observation", () => {
  const older = listing("flat-a");
  const newer = listing("flat-a-duplicate", {
    url: older.url,
    rentRub: 54_000,
    title: "Обновлённая тестовая квартира",
  });
  const offers = projectHousingShortlist(
    [snapshot(start, true, older), snapshot(updated, false, newer)],
    now,
  );

  assert.deepEqual(
    offers.map(({ url, title, rentRub, lastSeenAt }) => ({
      url,
      title,
      rentRub,
      lastSeenAt,
    })),
    [
      {
        url: newer.url,
        title: newer.title,
        rentRub: newer.rentRub,
        lastSeenAt: updated,
      },
    ],
  );
});

test("a complete snapshot with an invalid original URL is ignored as a whole", () => {
  const valid = listing("flat-a");
  const invalidUrls = [
    "https://not-rent.example/offer/flat-b",
    "http://rent.example/offer/flat-b",
    "https://rent.example/offer/flat-b?tracking=123",
    "https://rent.example/offer/flat-b#details",
    "https://guest@rent.example/offer/flat-b",
    "https://rent.example/other/flat-b",
  ];

  for (const url of invalidUrls) {
    const offers = projectHousingShortlist(
      [
        snapshot(start, true, valid),
        snapshot(updated, true, listing("flat-b", { url }), listing("flat-c")),
      ],
      now,
    );

    assert.deepEqual(
      offers.map(({ originalId, lastSeenAt }) => [originalId, lastSeenAt]),
      [["flat-a", start]],
      url,
    );
  }
});

test("a missing rent can match the saved city only when no ceiling was saved", () => {
  const offers = projectHousingShortlist(
    [
      snapshot(
        start,
        true,
        listing("unpriced", { rentRub: null }),
        listing("priced"),
        listing("outside", { city: "Казань" }),
        listing("over-budget", { rentRub: 80_000 }),
      ),
    ],
    now,
  );

  const withCeiling = selectHousingShortlist(offers, {
    city: "Москва",
    budgetRub: 55_000,
  });
  assert.deepEqual(
    withCeiling.map(({ offer }) => offer.originalId),
    ["priced"],
  );
  assert.deepEqual(
    new Set(withCeiling[0]?.matches),
    new Set(["city", "budget"]),
  );

  const open = selectHousingShortlist(offers, {
    city: "Москва",
    budgetRub: null,
  });
  assert.equal(open.length, 3);
  assert.deepEqual(
    open
      .filter(({ offer }) => offer.rentRub === null)
      .map(({ offer, matches }) => [offer.originalId, matches]),
    [["unpriced", ["city"]]],
  );
});

test("the shortlist caps exact city matches at three and leaves an unknown city empty", () => {
  const offers = projectHousingShortlist(
    [
      snapshot(
        start,
        true,
        ...["flat-a", "flat-b", "flat-c", "flat-d"].map((id) => listing(id)),
        listing("flat-other", { city: "Московская область" }),
      ),
    ],
    now,
  );
  const selected = selectHousingShortlist(offers, {
    city: " Москва ",
    budgetRub: null,
  });

  assert.equal(selected.length, 3);
  assert.ok(
    selected.every(
      ({ offer, matches }) =>
        offer.city === "Москва" && matches.join() === "city",
    ),
  );
  assert.deepEqual(
    selectHousingShortlist(offers, { city: "", budgetRub: null }),
    [],
  );
});

test("the demo is restricted to loopback hosts rather than look-alike domains", () => {
  for (const host of [
    "localhost",
    "localhost:3000",
    "127.0.0.1:3000",
    "[::1]:3000",
  ])
    assert.equal(isHousingShortlistLoopback(host), true, host);

  for (const host of [
    "",
    "pilot.citygo.test",
    "localhost.example",
    "localhost@outside.test",
    "localhost:3000/path",
    "localhost\n",
  ])
    assert.equal(isHousingShortlistLoopback(host), false, host);
});
