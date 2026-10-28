"use client";
import { useEffect, useState } from "react";
import { Button } from "@citygo/ui-web";
import {
  browserAnalyticsOptedOut,
  setBrowserAnalyticsOptOut,
} from "./use-product-analytics";

/** A local choice, separate from required service consent and registration. */
export function AnalyticsPreference() {
  const [optedOut, setOptedOut] = useState(true);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const update = () => setOptedOut(browserAnalyticsOptedOut());
    update();
    setReady(true);
    window.addEventListener("storage", update);
    window.addEventListener("citygo:analytics-preference", update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("citygo:analytics-preference", update);
    };
  }, []);
  return (
    <section aria-label="Настройки необязательной аналитики">
      <p role="status">
        {optedOut
          ? "Необязательная аналитика отключена в этом браузере."
          : "В этом браузере разрешена необязательная аналитика, если она включена в сервисе."}
      </p>
      <Button
        type="button"
        disabled={!ready}
        onClick={() => {
          setBrowserAnalyticsOptOut(!optedOut);
          setOptedOut(browserAnalyticsOptedOut());
        }}
      >
        {optedOut ? "Разрешить аналитику" : "Отключить аналитику"}
      </Button>
      <p>
        Выбор сохраняется только в этом браузере. Настройки защиты браузера
        имеют приоритет. Для возобновления аналитики откройте приложение заново.
      </p>
    </section>
  );
}
