import type { Metadata } from "next";
import { LandingV8 } from "../../../components/landing/landing-v8";
import { LandingAnalytics } from "../../../components/landing/landing-analytics";

export const metadata: Metadata = {
  title: "Ситиго — переезд в Москву под вашу жизнь",
  description:
    "Сравните свои варианты переезда: жильё, работа, бюджет и конкретный следующий шаг с ИИ-помощниками CityGo.",
  robots: { index: false, follow: true },
  referrer: "origin",
};

export default function LandingV8Page() {
  return (
    <>
      <LandingV8 />
      <LandingAnalytics variant="v8" />
    </>
  );
}
