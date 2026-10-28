import type { Route } from "@playwright/test";
import { customerInteractionInputSchema } from "../packages/contracts/src/admin-customer-observability";

/** Opt-in only for existing synthetic API fixtures, never for real-API specs. */
export async function fulfillProductAnalytics(route: Route): Promise<boolean> {
  const request = route.request();
  if (
    new URL(request.url()).pathname !== "/api/v1/analytics/events" ||
    request.method() !== "POST"
  )
    return false;
  // A text/contact/URL or arbitrary extra key must fail the browser test.
  customerInteractionInputSchema.parse(request.postDataJSON());
  await route.fulfill({ json: { recorded: true } });
  return true;
}
