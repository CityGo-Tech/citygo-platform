import type { Metadata } from "next";
import { MaxEntry } from "../../../components/mini-app/max-entry";

export const metadata: Metadata = {
  title: "CityGo в MAX",
  robots: { index: false, follow: false },
};

export default function MaxMiniAppPage() {
  return <MaxEntry />;
}
