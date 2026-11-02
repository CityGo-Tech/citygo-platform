import type { BrowserContext } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";
const catalogId = "b".repeat(64);
const policyId = "a".repeat(64);
export async function pdfMaterialFixture(context: BrowserContext) {
  const state = {
    owner: "101",
    sends: [] as { threadId: string; input: Record<string, unknown> }[],
    unexpected: [] as string[],
    external: 0,
    hold: false,
    release: () => {},
  };
  const gate = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const messages: Message[] = [];
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: `material-${state.owner}@example.test`,
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    xp: 0,
    quests: [],
    thread: {
      id: state.owner === "101" ? "20" : "30",
      agentKey: "housing",
      assistantKey: "housing",
      closed: false,
      messages:
        state.owner === "101"
          ? messages
          : [
              {
                id: "301",
                role: "assistant",
                agentKey: "housing",
                status: "complete",
                content: "НОВЫЙ_ВЛАДЕЛЕЦ_МАТЕРИАЛА",
              },
            ],
    },
    provider: "routerai",
    aiAccess: {
      policy: {
        id: policyId,
        version: "synthetic-material",
        provider: "routerai",
        model: "synthetic/model",
        recipient: "Synthetic",
        routing: "Synthetic",
        data: "Synthetic",
      },
      granted: true,
      dailyLimit: 100,
      modes: {
        catalogId,
        defaultMode: "balanced",
        options: [
          {
            id: "maximum",
            label: "Максимум",
            available: true,
            consentRequired: false,
          },
          {
            id: "balanced",
            label: "Баланс",
            available: true,
            consentRequired: false,
          },
          {
            id: "minimum",
            label: "Минимум",
            available: true,
            consentRequired: false,
            price: { kind: "fixed", currency: "RUB", amountMicros: 3_000_000 },
          },
        ],
      },
      credit: {
        currency: "RUB",
        bonusGranted: false,
        grantedMicros: 100_000_000,
        heldMicros: 0,
        spentMicros: 0,
        availableMicros: 100_000_000,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: 0,
        topUpAvailable: true,
        history: [],
      },
    },
  });
  await context.route("https://**", (route) => {
    state.external++;
    return route.abort();
  });
  await context.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: board() });
    if (path === "/api/v1/account/consents")
      return route.fulfill({
        json: {
          policy: syntheticConsentPolicy,
          personalDataGranted: true,
          marketingGranted: true,
          serviceConsentRequired: false,
          currentAiConsentRequired: false,
        },
      });
    if (/^\/api\/v1\/conversations\/(20|30)$/.test(path))
      return route.fulfill({
        json: { userId: state.owner, thread: board().thread },
      });
    const send = path.match(/^\/api\/v1\/threads\/(20|30)\/messages$/);
    if (send && method === "POST") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      state.sends.push({ threadId: send[1]!, input });
      if (state.hold) await gate;
      messages.push(
        {
          id: "100",
          role: "user",
          agentKey: "housing",
          status: "complete",
          content: String(input.text),
        },
        {
          id: "101",
          role: "assistant",
          agentKey: "housing",
          status: "complete",
          content: "ПРОВЕРОЧНЫЙ_ОТВЕТ",
        },
      );
      return route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: `data: ${JSON.stringify({ type: "delta", text: "ПРОВЕРОЧНЫЙ_ОТВЕТ" })}\n\ndata: ${JSON.stringify({ type: "done", messageId: "101" })}\n\n`,
      });
    }
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic material request" },
    });
  });
  return state;
}
