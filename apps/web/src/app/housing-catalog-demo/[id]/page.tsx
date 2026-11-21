import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Card } from "@citygo/ui-web";
import { isHousingShortlistLoopback } from "../../../components/housing-shortlist-data";
import {
  housingShortlistOfferPool,
  housingShortlistPrice,
  housingShortlistSource,
  housingShortlistTime,
} from "../../../components/housing-shortlist-fixture";
import styles from "../../../components/housing-starter-plan.module.css";

export const metadata: Metadata = {
  title: "Объявление · учебный источник CityGo",
  robots: { index: false, follow: false },
};

export default async function HousingDemoOriginal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const host = (await headers()).get("host") ?? "";
  if (!isHousingShortlistLoopback(host)) notFound();
  const { id } = await params;
  const offer = housingShortlistOfferPool.find(
    (entry) => entry.originalId === id,
  );
  if (!offer) notFound();

  return (
    <main className={styles.demoOriginal}>
      <Card className={styles.panel}>
        <p className={styles.eyebrow}>Демонстрационный оригинал</p>
        <h1>{offer.title}</h1>
        <p>
          {offer.city}, {offer.district} ·{" "}
          {housingShortlistPrice(offer.rentRub)}
        </p>
        <p>Источник · {housingShortlistSource}</p>
        <p>
          Последний раз видели ·{" "}
          <time dateTime={offer.lastSeenAt}>
            {housingShortlistTime(offer.lastSeenAt)}
          </time>
        </p>
        <p>
          Учебное объявление без адреса, контактов и возможности бронирования.
        </p>
      </Card>
    </main>
  );
}
