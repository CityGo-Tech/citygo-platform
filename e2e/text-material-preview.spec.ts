import { modeSelector, chooseMode } from "./ai-mode-navigation";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { Dashboard, Message } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const catalogId = "b".repeat(64);
const policyId = "a".repeat(64);
const composer = (page: Page) =>
  page.getByLabel("Сообщение помощнику", { exact: true });
const entry = (page: Page) =>
  page.getByRole("button", { name: "Прикрепить материал", exact: true });
const upload = (page: Page) =>
  page.getByLabel("TXT до 64 КБ или PDF с текстом до 8 МБ и 50 страниц", {
    exact: true,
  });
const preview = (page: Page) =>
  page.getByLabel("Текст из TXT-файла", { exact: true });

async function fixture(context: BrowserContext) {
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

test("real TXT preview edits only the draft; explicit Send retains the helper, AI mode and reserve", async ({
  page,
  context,
}, info) => {
  const state = await fixture(context);
  state.hold = true;
  await page.goto("/");
  await composer(page).fill("Помогите оценить условия");
  await chooseMode(page, "minimum");
  await entry(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Прикрепить материал к разговору",
  });
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: info.outputPath("text-material-selection.png"),
  });
  await upload(page).setInputFiles({
    name: "<img onerror=secret>.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Район: Текстильщики\nБюджет: 50 000 ₽"),
  });
  await expect(preview(page)).toHaveValue(
    "Район: Текстильщики\nБюджет: 50 000 ₽",
  );
  await expect(
    page.getByRole("heading", {
      name: "<img onerror=secret>.txt",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page
      .getByRole("dialog", { name: "Предпросмотр материала", exact: true })
      .locator("img")
      .count(),
  ).toBe(0);
  await preview(page).fill("Проверенный текст материала");
  expect(state.sends).toEqual([]);
  await expect(
    page.getByRole("dialog", { name: "Предпросмотр материала", exact: true }),
  ).toHaveClass(/ym-hide-content/);
  await expect(preview(page)).toHaveClass(/ym-disable-keys/);
  await page
    .getByRole("heading", { name: "Предпросмотр материала", exact: true })
    .focus();
  await page
    .getByRole("dialog", { name: "Предпросмотр материала", exact: true })
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  await page.screenshot({
    path: info.outputPath("text-material-preview.png"),
    fullPage: false,
  });
  expect(
    await page
      .getByRole("dialog", { name: "Предпросмотр материала", exact: true })
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("text-material-actions.png") });
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(entry(page)).toBeFocused();
  await expect(composer(page)).toHaveValue(
    "Помогите оценить условия\n\nМатериал:\nПроверенный текст материала",
  );
  expect(state.sends).toEqual([]);
  await expect(modeSelector(page)).toHaveAttribute("data-ai-mode", "minimum");
  try {
    await page.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect.poll(() => state.sends.length).toBe(1);
    await expect(entry(page)).toBeDisabled();
    expect(state.sends[0]).toEqual({
      threadId: "20",
      input: {
        text: "Помогите оценить условия\n\nМатериал:\nПроверенный текст материала",
        requestId: expect.any(String),
        policyId,
        creditReservationMode: "fixed5_overdraft",
        aiMode: "minimum",
        aiModeCatalogId: catalogId,
      },
    });
  } finally {
    state.release();
  }
  await expect(entry(page)).toBeEnabled();
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("invalid files and combined overflow remain local, preserve the question and support back/Escape", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  const question = "В".repeat(99950);
  await composer(page).fill(question);
  await entry(page).click();
  for (const invalid of [
    {
      name: "resume.pdf",
      buffer: Buffer.from("%PDF fake"),
      error: "Не удалось прочитать PDF",
    },
    {
      name: "large.txt",
      buffer: Buffer.alloc(1024 * 1024 + 1, 65),
      error: "Файл больше 1 МБ",
    },
    {
      name: "invalid.txt",
      buffer: Buffer.from([0xc3, 0x28]),
      error: "Не удалось прочитать UTF-8",
    },
    {
      name: "binary.txt",
      buffer: Buffer.from([65, 0, 66]),
      error: "нетекстовые данные",
    },
    {
      name: "long.txt",
      buffer: Buffer.from("Я".repeat(200001)),
      error: "больше 200 000 символов",
    },
  ]) {
    await upload(page).setInputFiles({
      name: invalid.name,
      mimeType: "text/plain",
      buffer: invalid.buffer,
    });
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      invalid.error,
    );
    await expect(preview(page)).toHaveCount(0);
  }
  await upload(page).setInputFiles({
    name: "valid.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("М".repeat(100)),
  });
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .scrollIntoViewIfNeeded();
  await page
    .getByRole("button", { name: "Добавить в сообщение", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "до 100 000 символов",
  );
  await expect(preview(page)).toHaveValue("М".repeat(100));
  await page
    .getByRole("button", { name: "Назад к выбору", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Выбрать файл", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(entry(page)).toBeFocused();
  await expect(composer(page)).toHaveValue(question);
  expect(state.sends).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test("closing a delayed local read and replacing its owner cannot reveal or append the old material", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (!this.name.startsWith("delayed")) return read.call(this);
      return new Promise<ArrayBuffer>((resolve) => {
        Object.assign(window, {
          releaseMaterial: async () => resolve(await read.call(this)),
        });
      });
    };
  });
  const release = () =>
    page.evaluate(async () => {
      const windowWithRelease = window as typeof window & {
        releaseMaterial?: () => Promise<void>;
      };
      await windowWithRelease.releaseMaterial?.();
    });
  await page.goto("/");
  await composer(page).fill("Мой сохранённый вопрос");
  await entry(page).click();
  await upload(page).setInputFiles({
    name: "delayed-close.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("ЛИЧНЫЙ_ПОЗДНИЙ_МАТЕРИАЛ"),
  });
  await expect(
    page.getByRole("status", { name: "" }).filter({ hasText: "Читаем текст" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Вернуться к разговору", exact: true })
    .click();
  await release();
  await expect(composer(page)).toHaveValue("Мой сохранённый вопрос");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await entry(page).click();
  await upload(page).setInputFiles({
    name: "delayed-owner.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("МАТЕРИАЛ_ПРЕЖНЕГО_ВЛАДЕЛЬЦА"),
  });
  await expect(page.getByText("Читаем текст…", { exact: true })).toBeVisible();
  state.owner = "202";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page
      .getByRole("log", { name: "История диалога", exact: true })
      .getByText("НОВЫЙ_ВЛАДЕЛЕЦ_МАТЕРИАЛА", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await release();
  await expect(composer(page)).toHaveValue("");
  await expect(
    page.getByText("МАТЕРИАЛ_ПРЕЖНЕГО_ВЛАДЕЛЬЦА", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("ЛИЧНЫЙ_ПОЗДНИЙ_МАТЕРИАЛ", { exact: true }),
  ).toHaveCount(0);
  expect(state.sends).toEqual([]);
  expect(state.external).toBe(0);
  expect(state.unexpected).toEqual([]);
});
