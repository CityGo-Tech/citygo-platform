import { expect, type BrowserContext } from "@playwright/test";
import type {
  Dashboard,
  Message,
  ServiceConsentState,
} from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";

export type ModeId = "maximum" | "balanced" | "minimum";
type Send = {
  text: string;
  requestId: string;
  policyId?: string;
  creditReservationMode?: string;
  aiMode?: ModeId;
  aiModeCatalogId?: string;
};
export const catalogId = "b".repeat(64);
export const policyId = "a".repeat(64);

/** Only synthetic HTTP/SSE responses; every provider destination is blocked. */
export async function fixture(
  context: BrowserContext,
  options: {
    legacy?: boolean;
    maximumAvailable?: boolean;
    minimumAvailable?: boolean;
    minimumPrice?: boolean;
    firstChoiceConsent?: boolean;
    assistantContextAvailable?: boolean;
    profile?: Dashboard["profile"];
    initialMessages?: Message[];
  } = {},
) {
  const messages: Message[] = options.initialMessages?.map((message) => ({
    ...message,
  })) ?? [
    {
      id: "100",
      role: "user",
      agentKey: "support",
      status: "complete",
      content: "СОХРАНЁННЫЙ_ВОПРОС",
    },
    {
      id: "101",
      role: "assistant",
      agentKey: "support",
      status: "complete",
      content: "СОХРАНЁННЫЙ_ОТВЕТ",
    },
  ];
  const state = {
    owner: "101",
    catalogId,
    authenticated: true,
    sends: [] as Send[],
    dashboardReads: 0,
    nextMessage: 200,
    holdStream: false,
    holdRefresh: false,
    failNextSend: false,
    releaseStream: () => {},
    releaseRefresh: () => {},
    external: 0,
    unexpected: [] as string[],
    consentReads: 0,
    consentSaves: [] as unknown[],
    consentOwners: new Set<string>(),
    failConsentRead: false,
    holdConsentRead: false,
    holdConsentSave: false,
    holdConsentRefresh: false,
    releaseConsentRead: () => {},
    releaseConsentSave: () => {},
  };
  const streamGate = new Promise<void>((resolve) => {
    state.releaseStream = resolve;
  });
  const refreshGate = new Promise<void>((resolve) => {
    state.releaseRefresh = resolve;
  });
  const consentReadGate = new Promise<void>((resolve) => {
    state.releaseConsentRead = resolve;
  });
  const consentSaveGate = new Promise<void>((resolve) => {
    state.releaseConsentSave = resolve;
  });
  const consentRequired = () =>
    Boolean(
      options.firstChoiceConsent && !state.consentOwners.has(state.owner),
    );
  const consentState = (required = consentRequired()): ServiceConsentState => ({
    policy: {
      ...syntheticConsentPolicy,
      aiProcessing: {
        id: policyId,
        version: "synthetic-modes",
        provider: "routerai",
        model: "synthetic/modes",
        recipient: "SYNTHETIC_FULL_RECIPIENTS",
        routing: "SYNTHETIC_FULL_ROUTES",
        data: "Synthetic selected-dialog context",
      },
      personalData: {
        ...syntheticConsentPolicy.personalData,
        text: "Полные условия новых режимов: SYNTHETIC_FULL_RECIPIENTS и SYNTHETIC_FULL_ROUTES. Передаётся контекст выбранного диалога.",
      },
    },
    personalDataGranted: true,
    marketingGranted: true,
    serviceConsentRequired: false,
    currentAiConsentRequired: required,
  });
  const board = (): Dashboard => ({
    ...(options.assistantContextAvailable === undefined
      ? {}
      : { assistantContextAvailable: options.assistantContextAvailable }),
    user: {
      id: state.owner,
      email: `modes-${state.owner}@example.test`,
      role: "user",
      mustChangePassword: false,
    },
    profile: state.owner === "101" ? (options.profile ?? null) : null,
    xp: 0,
    quests: [],
    thread: {
      id: state.owner === "101" ? "20" : "30",
      agentKey: "support",
      assistantKey: "support",
      closed: false,
      messages: state.owner === "101" ? messages : [],
    },
    provider: "routerai",
    aiAccess: {
      policy: {
        id: policyId,
        version: "synthetic-modes",
        provider: "routerai",
        model: "PRIVATE_MODEL_DO_NOT_RENDER",
        recipient: "PRIVATE_RECIPIENT_DO_NOT_RENDER",
        routing: "Synthetic transport only",
        data: "Fictional context only",
      },
      granted: true,
      dailyLimit: 100,
      ...(!options.legacy
        ? {
            modes: {
              catalogId: state.catalogId,
              defaultMode: "balanced" as const,
              options: [
                {
                  id: "maximum" as const,
                  label: "Максимум",
                  available: options.maximumAvailable ?? true,
                  consentRequired: consentRequired(),
                },
                {
                  id: "balanced" as const,
                  label: "Баланс",
                  available: true,
                  consentRequired: false,
                },
                {
                  id: "minimum" as const,
                  label: "Минимум",
                  available: options.minimumAvailable ?? true,
                  consentRequired: consentRequired(),
                  ...(options.minimumPrice
                    ? {
                        price: {
                          kind: "fixed" as const,
                          currency: "RUB" as const,
                          amountMicros: 3_000_000,
                        },
                      }
                    : {}),
                },
              ],
            },
          }
        : {}),
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
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    if (path === "/api/v1/auth/registration-policy" && method === "GET")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (path === "/api/v1/auth/logout" && method === "POST") {
      state.authenticated = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/v1/auth/login" && method === "POST") {
      state.authenticated = true;
      state.owner = "202";
      return route.fulfill({ json: { user: board().user } });
    }
    if (!state.authenticated)
      return route.fulfill({
        status: 401,
        json: { error: "Synthetic signed-out session" },
      });
    if (path === "/api/v1/dashboard" && method === "GET") {
      state.dashboardReads++;
      if (state.holdConsentRefresh && state.consentSaves.length) {
        state.holdConsentRefresh = false;
        await refreshGate;
      }
      if (state.holdRefresh && state.sends.length) {
        state.holdRefresh = false;
        await refreshGate;
      }
      return route.fulfill({ json: board() });
    }
    if (path === "/api/v1/account/consents" && method === "GET") {
      state.consentReads++;
      const result = consentState();
      if (state.holdConsentRead) {
        state.holdConsentRead = false;
        await consentReadGate;
      }
      if (state.failConsentRead) {
        state.failConsentRead = false;
        return route.fulfill({
          status: 503,
          json: { error: "Synthetic consent read failure" },
        });
      }
      return route.fulfill({ json: result });
    }
    if (path === "/api/v1/account/ai-modes-consent" && method === "POST") {
      const input = request.postDataJSON();
      state.consentSaves.push(input);
      const owner = state.owner;
      expect(input).toEqual({
        expectedUserId: owner,
        policyVersion: syntheticConsentPolicy.version,
        policyId,
        personalData: true,
      });
      if (state.holdConsentSave) {
        state.holdConsentSave = false;
        await consentSaveGate;
      }
      state.consentOwners.add(owner);
      return route.fulfill({ json: consentState(false) });
    }
    if (path === "/api/v1/account/profile" && method === "GET")
      return route.fulfill({
        json: {
          userId: state.owner,
          email: board().user.email,
          emailVerified: true,
          phoneVerified: true,
          giftStatus: "claimed",
          emailConfirmation: "available",
        },
      });
    if (path === "/api/v1/personal-plan/summary" && method === "GET")
      return route.fulfill({
        json: { userId: state.owner, total: 0, pending: 0, completed: 0 },
      });
    if (path === "/api/v1/personal-plan" && method === "GET")
      return route.fulfill({
        json: { userId: state.owner, items: [], nextBefore: null },
      });
    const send = path.match(/^\/api\/v1\/threads\/(20|30)\/messages$/);
    if (send && method === "POST") {
      const payload = request.postDataJSON() as Send;
      state.sends.push(payload);
      expect(send[1]).toBe(state.owner === "101" ? "20" : "30");
      if (state.failNextSend) {
        state.failNextSend = false;
        return route.fulfill({
          status: 409,
          json: {
            error: "Режим временно недоступен",
            code: "AI_UNAVAILABLE",
            retryable: false,
          },
        });
      }
      if (state.holdStream) {
        state.holdStream = false;
        await streamGate;
      }
      const answer = "ОТВЕТ_НА_" + payload.text;
      const assistantId = String(state.nextMessage + 1);
      messages.push(
        {
          id: String(state.nextMessage++),
          role: "user",
          agentKey: "support",
          status: "complete",
          content: payload.text,
        },
        {
          id: String(state.nextMessage++),
          role: "assistant",
          agentKey: "support",
          status: "complete",
          content: answer,
        },
      );
      return route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: `data: ${JSON.stringify({ type: "delta", text: answer })}\n\ndata: ${JSON.stringify({ type: "done", messageId: assistantId })}\n\n`,
      });
    }
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic AI-mode request" },
    });
  });
  return state;
}

export function noOtherTraffic(state: Awaited<ReturnType<typeof fixture>>) {
  expect(state.unexpected).toEqual([]);
  expect(state.external).toBe(0);
}
