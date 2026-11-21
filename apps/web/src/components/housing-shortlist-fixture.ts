import {
  projectHousingShortlist,
  type HousingShortlistListing,
  type HousingShortlistSnapshot,
} from "./housing-shortlist-data";

// Fixed demo clock for reproducible ages; these are invented, not observations.
export const housingShortlistDemoTime = "2026-11-21T10:00:00.000Z";
export const housingShortlistSource = "Демонстрационная выгрузка";

function listing(
  id: string,
  title: string,
  district: string,
  rentRub: number | null,
  city = "Москва",
): HousingShortlistListing {
  return {
    id,
    title,
    district,
    rentRub,
    city,
    url: `https://rent.example/offer/${id}`,
  };
}

const metro = listing("metro", "Квартира у метро", "Сокол", 54_000);
const stale = listing("stale", "Устаревшее объявление", "Сокол", 43_000);
const withdrawn = listing("withdrawn", "Снятое объявление", "Сокол", 41_000);

const snapshots = [
  {
    capturedAt: "2026-11-20T05:00:00.000Z",
    complete: true,
    listings: [stale, withdrawn],
  },
  {
    capturedAt: "2026-11-20T08:00:00.000Z",
    complete: true,
    listings: [stale],
  },
  {
    capturedAt: "2026-11-21T08:30:00.000Z",
    complete: false,
    listings: [
      metro,
      { ...metro, id: "metro-duplicate" },
      listing("park", "Квартира рядом с парком", "Измайлово", 63_000),
      listing("unknown", "Квартира без указанной цены", "Текстильщики", null),
      listing("z-high", "Квартира выше бюджета", "Дорогомилово", 96_000),
      listing(
        "other",
        "Квартира в другом городе",
        "Вахитовский",
        39_000,
        "Казань",
      ),
    ],
  },
] satisfies HousingShortlistSnapshot[];

export const housingShortlistOfferPool = projectHousingShortlist(
  snapshots,
  Date.parse(housingShortlistDemoTime),
);

const observedTime = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Moscow",
});
const rentAmount = new Intl.NumberFormat("ru-RU");

export function housingShortlistTime(date: string) {
  return observedTime.format(new Date(date)) + " мск";
}
export function housingShortlistPrice(rentRub: number | null) {
  return rentRub === null
    ? "Цена не указана"
    : rentAmount.format(rentRub) + " ₽/мес.";
}
