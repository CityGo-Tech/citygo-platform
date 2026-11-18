import type { Metadata } from "next";
import { TelegramEntry } from "../../../components/mini-app/telegram-entry";

export const metadata: Metadata = {
  title: "CityGo в Telegram",
  robots: { index: false, follow: false },
};

export default function TelegramMiniAppPage() {
  return <TelegramEntry />;
}
