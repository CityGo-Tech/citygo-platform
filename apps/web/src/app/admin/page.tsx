"use client";
import { AdminOverview } from "@citygo/admin";
import { parseProductAnalyticsConfig } from "../../components/product-analytics";
export default function AdminPage() {
  const analytics = parseProductAnalyticsConfig({
    enabled: process.env.NEXT_PUBLIC_CITYGO_METRIKA_ENABLED,
    counterId: process.env.NEXT_PUBLIC_CITYGO_METRIKA_COUNTER_ID,
    webvisor: process.env.NEXT_PUBLIC_CITYGO_METRIKA_WEBVISOR,
  });
  return (
    <AdminOverview
      metrikaCounterId={analytics.enabled ? analytics.counterId : null}
    />
  );
}
