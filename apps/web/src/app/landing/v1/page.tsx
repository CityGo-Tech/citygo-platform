import type { Metadata } from "next";
import { LandingV1 } from "../../../components/landing/landing-v1";
import { LandingAnalytics } from "../../../components/landing/landing-analytics";

export const metadata: Metadata = {
  title: "Ситиго — мечта о Москве, план под вашу жизнь",
  description:
    "ИИ-помощники CityGo помогут разобраться с жильём, работой и бюджетом, чтобы решить, подходит ли вам Москва и с чего начать.",
  robots: { index: false, follow: true },
  referrer: "origin",
};

export default function LandingV1Page() {
  return (
    <>
      <LandingV1 />
      <LandingAnalytics variant="v1" />
    </>
  );
}
