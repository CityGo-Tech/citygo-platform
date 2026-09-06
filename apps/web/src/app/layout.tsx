import type { Metadata } from "next";
import "@citygo/design-tokens/tokens.css";
import "@citygo/ui-web/styles.css";
import "./globals.css";
export const metadata: Metadata = {
  title: "CityGo — ваш следующий шаг",
  description: "Личный план переезда и AI-помощники CityGo",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
