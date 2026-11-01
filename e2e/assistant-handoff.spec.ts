import { openMessageActions } from "./navigation-helper";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { AgentKey, Dashboard, Message } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const sourceText = "ПОДТВЕРЖДЁННЫЙ_ФРАГМЕНТ: хочу найти работу после переезда.";
const reviewed = "Мой проверенный фрагмент для резюме 🧳";
const sourceDraft = "Мой неотправленный вопрос про жильё";
const targetDraft = "Ранее сохранённый вопрос по резюме";
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });
const sourceArticle = (page: Page) =>
  page.getByRole("log").locator("article").filter({ hasText: sourceText });

async function fixture(context: BrowserContext, paginated = false) {
  let releaseStart!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const state = {
    owner: "101",
    starts: [] as AgentKey[],
    historyReads: [] as string[],
    sends: 0,
    external: 0,
    failingRead: false,
    holdStart: false,
    releaseStart,
    unexpected: [] as string[],
  };
  const recentMessages: Message[] = [
    {
      id: "200",
      role: "user",
      agentKey: "housing",
      status: "complete",
      content: "Мой исходный вопрос",
    },
    {
      id: "201",
      role: "assistant",
      agentKey: "housing",
      status: "complete",
      content: sourceText,
    },
    {
      id: "202",
      role: "assistant",
      agentKey: "housing",
      status: "interrupted",
      content: "ПРЕРВАННЫЙ_ОТВЕТ",
    },
  ];
  const messages: Message[] = paginated
    ? Array.from({ length: 100 }, (_, index) => ({
        id: String(200 + index),
        role: index % 2 ? "assistant" : "user",
        agentKey: "housing",
        status: "complete",
        content: `Последняя страница: сообщение ${200 + index}`,
      }))
    : recentMessages;
  const olderMessage: Message = {
    id: "199",
    role: "assistant",
    agentKey: "housing",
    status: "complete",
    content: sourceText,
  };
  const thread = (id: string): NonNullable<Dashboard["thread"]> =>
    id === "21"
      ? {
          id,
          agentKey: "resume-builder",
          assistantKey: "resume-builder",
          closed: false,
          messages: [
            {
              id: "300",
              role: "assistant",
              agentKey: "resume-builder",
              status: "complete",
              content: "ПРЕЖНИЙ_РАЗГОВОР_ПО_РЕЗЮМЕ",
            },
          ],
        }
      : {
          id: state.owner === "101" ? "20" : "30",
          agentKey: "housing",
          assistantKey: "housing",
          closed: false,
          messages:
            state.owner === "101"
              ? messages
              : [
                  {
                    id: "400",
                    role: "assistant",
                    agentKey: "housing",
                    status: "complete",
                    content: "НОВЫЙ_ВЛАДЕЛЕЦ",
                  },
                ],
        };
  const board = (): Dashboard => ({
    user: {
      id: state.owner,
      email: "handoff-" + state.owner + "@example.test",
      role: "user",
      mustChangePassword: false,
    },
    profile: null,
    xp: 0,
    quests: [],
    thread: thread("20"),
    provider: "routerai",
    aiAccess: {
      policy: {
        id: "a".repeat(64),
        version: "synthetic",
        provider: "routerai",
        model: "synthetic/model",
        recipient: "Synthetic",
        routing: "Synthetic",
        data: "Synthetic",
      },
      granted: true,
      dailyLimit: 100,
      modes: {
        catalogId: "b".repeat(64),
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
            price: { kind: "fixed", currency: "RUB", amountMicros: 3000000 },
          },
        ],
      },
      credit: {
        currency: "RUB",
        bonusGranted: true,
        grantedMicros: 500000000,
        heldMicros: 0,
        spentMicros: 0,
        availableMicros: 500000000,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5000000,
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
      url = new URL(request.url()),
      path = url.pathname;
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
          marketingGranted: false,
          serviceConsentRequired: false,
          currentAiConsentRequired: false,
        },
      });
    if (path === "/api/v1/conversations/start" && request.method() === "POST") {
      const input = request.postDataJSON() as { agentKey: AgentKey };
      state.starts.push(input.agentKey);
      if (state.holdStart) await gate;
      return route.fulfill({
        json: {
          id: "21",
          agentKey: input.agentKey,
          assistantKey: input.agentKey,
          closed: false,
        },
      });
    }
    if (
      path === "/api/v1/conversations/20/messages" &&
      request.method() === "GET" &&
      paginated
    ) {
      const before = url.searchParams.get("before");
      state.historyReads.push("20:" + before);
      expect(before).toBe("200");
      return route.fulfill({
        json: {
          userId: state.owner,
          threadId: "20",
          messages: [olderMessage],
          nextCursor: null,
        },
      });
    }
    const read = path.match(/^\/api\/v1\/conversations\/(20|21|30)$/);
    if (read) {
      if (read[1] === "21" && state.failingRead)
        return route.fulfill({
          status: 503,
          json: { error: "Synthetic read failed" },
        });
      return route.fulfill({
        json: { userId: state.owner, thread: thread(read[1]!) },
      });
    }
    if (path === "/api/v1/conversations" && request.method() === "GET")
      return route.fulfill({
        json: {
          userId: state.owner,
          conversations: ["21", "20"].map((id) => ({
            id,
            agentKey: thread(id).agentKey,
            assistantKey: thread(id).assistantKey,
            closed: false,
            updatedAt: "2026-10-31T00:00:00Z",
            preview: thread(id).messages.at(-1)!.content,
          })),
          nextCursor: null,
        },
      });
    if (/\/threads\/\d+\/messages$/.test(path)) state.sends++;
    state.unexpected.push(request.method() + " " + path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic handoff request" },
    });
  });
  return state;
}

async function expectScrollableMobileHistory(page: Page) {
  if (!(await page.evaluate(() => matchMedia("(max-width: 900px)").matches))) {
    return;
  }
  const log = page.getByRole("log");
  await expect(log.locator("article")).toHaveCount(101);
  await expect(log).toHaveCSS("overflow-y", "auto");
  const geometry = await log.evaluate((history) => {
    const form = history
      .closest(".conversation-chat-card")
      ?.querySelector("form.conversation-composer");
    if (!(form instanceof HTMLElement)) {
      throw new Error(
        "The history must share its chat panel with the composer",
      );
    }
    return {
      height: history.clientHeight,
      scrollHeight: history.scrollHeight,
      bottom: history.getBoundingClientRect().bottom,
      composerTop: form.getBoundingClientRect().top,
    };
  });
  expect(geometry.height).toBeGreaterThanOrEqual(160);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.composerTop + 1);
}

async function openReview(page: Page) {
  await openMessageActions(sourceArticle(page));
  await sourceArticle(page)
    .getByRole("button", { name: "Другому помощнику", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Передадим только нужное" }),
  ).toBeVisible();
  await page
    .getByLabel("Кому передать фрагмент", { exact: true })
    .selectOption("resume-builder");
}

test("reviewed handoff appends to target draft, preserves both histories and original draft, and never sends", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  await page.addInitScript(
    (text) =>
      sessionStorage.getItem("citygo:chat-draft:v1:101:21") === null &&
      sessionStorage.setItem(
        "citygo:chat-draft:v1:101:21",
        JSON.stringify({ text, savedAt: Date.now() }),
      ),
    targetDraft,
  );
  await page.goto("/");
  await composer(page).fill(sourceDraft);
  await page
    .getByLabel("Режим работы", { exact: true })
    .selectOption("minimum");
  await openReview(page);
  await expect(page.getByLabel("Что передаём", { exact: true })).toHaveValue(
    sourceText,
  );
  await page.getByLabel("Что передаём", { exact: true }).fill(reviewed);
  await expect(page.getByRole("dialog")).toHaveClass(/ym-hide-content/);
  await expect(page.getByLabel("Что передаём", { exact: true })).toHaveClass(
    /ym-disable-keys/,
  );
  expect(state.starts).toEqual([]);
  expect(state.sends).toBe(0);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("assistant-handoff-review.png"),
  });
  await page
    .getByRole("button", { name: "Подготовить разговор", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer(page)).toHaveValue(targetDraft + "\n\n" + reviewed);
  await expect(page.getByRole("log")).toContainText(
    "ПРЕЖНИЙ_РАЗГОВОР_ПО_РЕЗЮМЕ",
  );
  await expect(page.getByLabel("Режим работы", { exact: true })).toHaveValue(
    "minimum",
  );
  expect(state.starts).toEqual(["resume-builder"]);
  const oldDraft = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("citygo:chat-draft:v1:101:20")!)
        .text as string,
  );
  expect(oldDraft).toBe(sourceDraft);
  // Do not replace persisted target draft with the init-script seed on reload.
  await page.reload();
  await expect(composer(page)).toHaveValue(targetDraft + "\n\n" + reviewed);
  expect(state.sends).toBe(0);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("handoff from a loaded older page keeps the authorized source and appends to the target draft without sending", async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  await page.addInitScript(
    (text) =>
      sessionStorage.getItem("citygo:chat-draft:v1:101:21") === null &&
      sessionStorage.setItem(
        "citygo:chat-draft:v1:101:21",
        JSON.stringify({ text, savedAt: Date.now() }),
      ),
    targetDraft,
  );
  await page.goto("/");
  await composer(page).fill(sourceDraft);
  await expect(sourceArticle(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Загрузить ранние сообщения", exact: true })
    .click();
  await expect(sourceArticle(page)).toHaveCount(1);
  expect(state.historyReads).toEqual(["20:200"]);
  await expectScrollableMobileHistory(page);
  await openReview(page);
  await expect(page.getByLabel("Что передаём", { exact: true })).toHaveValue(
    sourceText,
  );
  await page.getByLabel("Что передаём", { exact: true }).fill(reviewed);
  await page
    .getByRole("button", { name: "Подготовить разговор", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer(page)).toHaveValue(targetDraft + "\n\n" + reviewed);
  await expect(page.getByRole("log")).toContainText(
    "ПРЕЖНИЙ_РАЗГОВОР_ПО_РЕЗЮМЕ",
  );
  await expect(page.getByRole("log")).not.toContainText(sourceText);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("citygo:chat-draft:v1:101:20")!)
          .text as string,
    ),
  ).toBe(sourceDraft);
  await page.reload();
  await expect(composer(page)).toHaveValue(targetDraft + "\n\n" + reviewed);
  expect(state.starts).toEqual(["resume-builder"]);
  expect(state.sends).toBe(0);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("cancel keeps source and draft; interrupted replies have no transfer action", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  await composer(page).fill(sourceDraft);
  await expect(
    page
      .getByRole("log")
      .locator("article")
      .filter({ hasText: "ПРЕРВАННЫЙ_ОТВЕТ" })
      .getByRole("button", { name: "Другому помощнику", exact: true }),
  ).toHaveCount(0);
  await openReview(page);
  await page
    .getByLabel("Что передаём", { exact: true })
    .fill("Изменённый фрагмент");
  await page
    .getByRole("button", { name: "Остаться в разговоре", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer(page)).toHaveValue(sourceDraft);
  expect(state.starts).toEqual([]);
  expect(state.sends).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("failed target read keeps review text and source draft for an explicit retry", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.failingRead = true;
  await page.goto("/");
  await composer(page).fill(sourceDraft);
  await openReview(page);
  await page.getByLabel("Что передаём", { exact: true }).fill(reviewed);
  await page
    .getByRole("button", { name: "Подготовить разговор", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Не удалось подготовить разговор",
  );
  await expect(page.getByLabel("Что передаём", { exact: true })).toHaveValue(
    reviewed,
  );
  await expect(composer(page)).toHaveValue(sourceDraft);
  state.failingRead = false;
  await page
    .getByRole("button", { name: "Подготовить разговор", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer(page)).toHaveValue(reviewed);
  expect(state.starts).toEqual(["resume-builder", "resume-builder"]);
  expect(state.sends).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("one pending preparation freezes review and blocks cancellation or duplicate start", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.holdStart = true;
  await page.goto("/");
  await openReview(page);
  await page
    .getByRole("button", { name: "Подготовить разговор", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Готовим разговор…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Остаться в разговоре", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Что передаём", { exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(state.starts).toEqual(["resume-builder"]);
  state.releaseStart();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.starts).toEqual(["resume-builder"]);
  expect(state.sends).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("owner change clears an older-page review and never routes old personal text to another account", async ({
  page,
  context,
}) => {
  const state = await fixture(context, true);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Загрузить ранние сообщения", exact: true })
    .click();
  await expect(sourceArticle(page)).toHaveCount(1);
  await expectScrollableMobileHistory(page);
  await openReview(page);
  await page
    .getByLabel("Что передаём", { exact: true })
    .fill("СТАРЫЙ_ЛИЧНЫЙ_ФРАГМЕНТ");
  state.owner = "102";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText("НОВЫЙ_ВЛАДЕЛЕЦ");
  await expect(composer(page)).toHaveValue("");
  expect(state.starts).toEqual([]);
  expect(state.sends).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("a full target draft is never overwritten or silently truncated", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  const existing = "x".repeat(3999);
  await page.addInitScript(
    (text) =>
      sessionStorage.setItem(
        "citygo:chat-draft:v1:101:21",
        JSON.stringify({ text, savedAt: Date.now() }),
      ),
    existing,
  );
  await page.goto("/");
  await composer(page).fill(sourceDraft);
  await openReview(page);
  await page.getByLabel("Что передаём", { exact: true }).fill(reviewed);
  await page
    .getByRole("button", { name: "Подготовить разговор", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Не удалось подготовить разговор",
  );
  await expect(composer(page)).toHaveValue(sourceDraft);
  await expect(page.getByLabel("Что передаём", { exact: true })).toHaveValue(
    reviewed,
  );
  const saved = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("citygo:chat-draft:v1:101:21")!)
        .text as string,
  );
  expect(saved).toBe(existing);
  expect(state.sends).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("a late preparation after account replacement cannot commit the old excerpt", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.holdStart = true;
  await page.goto("/");
  await openReview(page);
  await page
    .getByLabel("Что передаём", { exact: true })
    .fill("СТАРЫЙ_ОТЛОЖЕННЫЙ_ФРАГМЕНТ");
  await page
    .getByRole("button", { name: "Подготовить разговор", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Готовим разговор…", exact: true }),
  ).toBeDisabled();
  state.owner = "102";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText("НОВЫЙ_ВЛАДЕЛЕЦ");
  state.releaseStart();
  await expect(composer(page)).toHaveValue("");
  await expect(page.getByRole("log")).not.toContainText(
    "СТАРЫЙ_ОТЛОЖЕННЫЙ_ФРАГМЕНТ",
  );
  expect(state.starts).toEqual(["resume-builder"]);
  expect(state.sends).toBe(0);
  expect(state.unexpected).toEqual([]);
});
