import type { Metadata } from "next";
import localFont from "next/font/local";
import "@citygo/design-tokens/tokens.css";
import "@citygo/ui-web/styles.css";
import "./globals.css";
import "./journey.css";
import "./prototype.css";
const manrope = localFont({
  src: "./fonts/Manrope.ttf",
  display: "swap",
  weight: "200 800",
  variable: "--cg-manrope",
});
export const metadata: Metadata = {
  title: "CityGo — ваш следующий шаг",
  description: "Личный план переезда и AI-помощники CityGo",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={manrope.variable}>
      <body>{children}</body>
    </html>
  );
}
