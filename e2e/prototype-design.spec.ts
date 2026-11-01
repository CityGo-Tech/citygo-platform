import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Locator,
} from "@playwright/test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Dashboard, PersonalPlanItem } from "@citygo/contracts";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { syntheticConsentPolicy } from "./service-consent-fixture";

const owner = "101";
const email = "prototype-owner@example.test";
const stamp = "2026-11-01T10:00:00.000Z";
const question = "Как спланировать переезд и выбрать район в Москве?";
const answer =
  "Начните с трёх ориентиров: удобная дорога, бюджет и привычный ритм жизни.\n\nСоставьте небольшой список районов, сравните время в пути и оставьте время на знакомство с городом. Конкретный план можно сохранить и дополнять в своём темпе.";
const plan: PersonalPlanItem[] = [
  {
    id: "9007199254741030",
    title: "Выбрать районы для знакомства",
    details: "Сравнить время в пути, прогулочные маршруты и стоимость жилья.",
    status: "pending",
    revision: 1,
    source: null,
    createdAt: stamp,
    updatedAt: stamp,
  },
  {
    id: "9007199254741029",
    title: "Составить бюджет переезда",
    details: "Учесть дорогу, жильё и первые недели в новом городе.",
    status: "completed",
    revision: 1,
    source: null,
    createdAt: stamp,
    updatedAt: stamp,
  },
];

/** A visual fixture cannot reach a provider, send a code, or create a checkout. */
async function install(context: BrowserContext, authenticated: boolean) {
  const state = {
    writes: [] as string[],
    unexpected: [] as string[],
    blockedExternal: [] as string[],
  };
  const thread: NonNullable<Dashboard["thread"]> = {
    id: "10",
    agentKey: "support",
    assistantKey: "support",
    closed: false,
    messages: [
      {
        id: "100",
        role: "user",
        agentKey: "support",
        status: "complete",
        content: question,
      },
      {
        id: "101",
        role: "assistant",
        agentKey: "support",
        status: "complete",
        content: answer,
      },
    ],
  };
  const board: Dashboard = {
    user: {
      id: owner,
      email,
      role: "user",
      mustChangePassword: false,
      serviceConsentRequired: false,
    },
    profile: null,
    quests: [],
    xp: 0,
    provider: "routerai",
    thread,
    aiAccess: {
      granted: true,
      dailyLimit: 100,
      policy: {
        id: "a".repeat(64),
        version: "prototype-synthetic-v1",
        provider: "routerai",
        model: "synthetic/no-provider-transport",
        recipient: "Synthetic fixture only",
        routing: "No external transport",
        data: "Fictional prototype content",
      },
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
          },
        ],
      },
      credit: {
        currency: "RUB",
        bonusGranted: true,
        grantedMicros: 500_000_000,
        availableMicros: 477_000_000,
        spentMicros: 23_000_000,
        heldMicros: 0,
        chargingStatus: "routerai_citygo_10x",
        reservationMode: "fixed5_overdraft",
        minimumRequestBalanceMicros: 5_000_000,
        outstandingDebtMicros: 0,
        topUpAvailable: true,
        history: [],
      },
    },
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://localhost:3000") {
      state.blockedExternal.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (await fulfillProductAnalytics(route)) return;
    const method = request.method();
    const path = url.pathname;
    if (method !== "GET") {
      state.writes.push(method + " " + path);
      return route.fulfill({
        status: 405,
        json: { error: "Read-only visual fixture" },
      });
    }
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "required",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    if (!authenticated)
      return route.fulfill({
        status: 401,
        json: { error: "Synthetic signed-out account" },
      });
    if (path === "/api/v1/dashboard") return route.fulfill({ json: board });
    if (path === "/api/v1/conversations/10")
      return route.fulfill({ json: { userId: owner, thread } });
    if (path === "/api/v1/conversations")
      return route.fulfill({
        json: {
          userId: owner,
          conversations: [
            {
              id: "10",
              agentKey: "support",
              assistantKey: "support",
              closed: false,
              updatedAt: stamp,
              preview: answer,
              customTitle: "Переезд в Москву",
              titleRevision: "1",
            },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/v1/personal-plan/summary")
      return route.fulfill({
        json: { userId: owner, total: 2, pending: 1, completed: 1 },
      });
    if (path === "/api/v1/personal-plan") {
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search")?.toLowerCase();
      return route.fulfill({
        json: {
          userId: owner,
          items: plan.filter(
            (item) =>
              (!status || item.status === status) &&
              (!search ||
                (item.title + item.details).toLowerCase().includes(search)),
          ),
          nextBefore: null,
        },
      });
    }
    if (path === "/api/v1/account/profile")
      return route.fulfill({
        json: {
          userId: owner,
          email,
          emailVerified: true,
          phoneVerified: true,
          giftStatus: "claimed",
          emailConfirmation: "available",
        },
      });
    state.unexpected.push(method + " " + path);
    return route.fulfill({
      status: 501,
      json: { error: "Unexpected visual fixture request" },
    });
  });
  return state;
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

async function privateText(page: Page, text: string) {
  const element = page
    .getByText(text.split("\n\n")[0]!, { exact: true })
    .first();
  await expect(element).toBeVisible();
  expect(
    await element.evaluate((node) => !!node.closest(".ym-hide-content")),
  ).toBe(true);
}

/** Assert original local artwork and browser decoding, not a substituted URL. */
async function decodedOriginalAsset(image: Locator, originalPath: string) {
  expect(originalPath).toMatch(/^\/figma\/[a-z0-9-]+\.(?:png|svg)$/);
  const file = await stat(
    join(process.cwd(), "apps/web/public", originalPath.slice(1)),
  );
  expect(file.isFile()).toBe(true);
  expect(file.size).toBeGreaterThan(0);
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  const observed = await image.evaluate(async (element) => {
    const node = element as HTMLImageElement;
    const source = new URL(node.getAttribute("src") ?? "", location.href);
    await node.decode();
    const current = new URL(node.currentSrc, location.href);
    const style = getComputedStyle(node);
    return {
      origin: source.origin,
      currentOrigin: current.origin,
      original:
        source.pathname === "/_next/image"
          ? source.searchParams.get("url")
          : source.pathname,
      complete: node.complete,
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height),
    };
  });
  expect(observed.origin).toBe("http://localhost:3000");
  expect(observed.currentOrigin).toBe("http://localhost:3000");
  expect(observed.original).toBe(originalPath);
  expect(observed.complete).toBe(true);
  expect(observed.naturalWidth).toBeGreaterThan(0);
  expect(observed.naturalHeight).toBeGreaterThan(0);
  return observed;
}

async function visibleAssetSize(image: Locator, width: number, height: number) {
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width - width)).toBeLessThan(0.08);
  expect(Math.abs(box!.height - height)).toBeLessThan(0.08);
}

async function originalLogo(page: Page, publicHeader = false) {
  const logo = page.getByRole("link", {
    name: "CityGo — главная",
    exact: true,
  });
  await expect(logo).toBeVisible();
  // Figma 6:7 / 6:8: the public anchor reserves 240px around a 192px
  // brand composition. Authenticated and mobile headers use the 192px slot.
  const slotWidth =
    publicHeader && (page.viewportSize()?.width ?? 1440) > 700 ? 240 : 192;
  await visibleAssetSize(logo, slotWidth, 40);
  const symbol = logo.locator(".citygo-brand-symbol");
  const wordmark = logo.locator(".citygo-brand-wordmark");
  await visibleAssetSize(symbol, 52, 36.63);
  await visibleAssetSize(wordmark, 128.65, 40);
  const symbolBox = await symbol.boundingBox();
  const wordmarkBox = await wordmark.boundingBox();
  expect(symbolBox).not.toBeNull();
  expect(wordmarkBox).not.toBeNull();
  expect(
    Math.abs(wordmarkBox!.x - symbolBox!.x - symbolBox!.width - 8),
  ).toBeLessThan(0.08);
  expect(
    wordmarkBox!.x + wordmarkBox!.width - symbolBox!.x,
  ).toBeLessThanOrEqual(192);
  for (const layer of [".citygo-brand-symbol", ".citygo-brand-wordmark"]) {
    const source = await logo
      .locator(layer)
      .evaluate((node) => getComputedStyle(node).backgroundImage);
    expect(source).toBe(
      'url("http://localhost:3000/figma/citygo-original-logo.png")',
    );
  }
  const file = await stat(
    join(process.cwd(), "apps/web/public/figma/citygo-original-logo.png"),
  );
  expect(file.isFile()).toBe(true);
  expect(file.size).toBeGreaterThan(0);
  const decoded = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/figma/citygo-original-logo.png";
    await image.decode();
    return {
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  });
  expect(decoded.complete).toBe(true);
  expect(decoded.width).toBeGreaterThan(0);
  expect(decoded.height).toBeGreaterThan(0);
}

async function catalogOriginalAssets(page: Page) {
  const size = (page.viewportSize()?.width ?? 1440) < 900 ? 64 : 88;
  for (const [label, key] of [
    ["Координатор переезда", "support"],
    ["Помощник по жилью", "housing"],
    ["Помощник по работе", "job-search"],
    ["Помощник по резюме", "resume-builder"],
    ["Гид по городской жизни", "digital-mentor"],
  ] as const) {
    const portrait = page
      .getByRole("article", { name: label, exact: true })
      .locator("img.assistant-catalog-portrait");
    await decodedOriginalAsset(portrait, `/figma/${key}-assistant.png`);
    await visibleAssetSize(portrait, size, size);
  }
  const bubble = page
    .getByRole("article", { name: "Bubble", exact: true })
    .getByRole("img", { name: "Логотип Bubble", exact: true });
  await bubble.scrollIntoViewIfNeeded();
  await expect(bubble).toBeVisible();
  await visibleAssetSize(bubble, 64, 64);
  const layers = bubble.locator("img");
  await expect(layers).toHaveCount(3);
  const gradient = layers.nth(0);
  await decodedOriginalAsset(gradient, "/figma/bubble-gradient.png");
  await visibleAssetSize(gradient, 64, 64);
  // Computed CSS dimensions exclude the top layer's intended rotation and
  // preserve each exported SVG's intrinsic filter bounds.
  const top = await decodedOriginalAsset(
    layers.nth(1),
    "/figma/bubble-highlight.svg",
  );
  expect(Math.abs(top.width - 26.6827)).toBeLessThan(0.08);
  expect(Math.abs(top.height - 17.7227)).toBeLessThan(0.08);
  const small = await decodedOriginalAsset(
    layers.nth(2),
    "/figma/bubble-small-highlight.svg",
  );
  expect(Math.abs(small.width - 8.864)).toBeLessThan(0.08);
  expect(Math.abs(small.height - 8.864)).toBeLessThan(0.08);
  await page.evaluate(() => window.scrollTo(0, 0));
}

test("prototype layout keeps chat, navigation and account views usable without a provider or business write", async ({
  page,
  context,
}, info) => {
  const state = await install(context, true);
  await page.goto("/");
  const navigation = page.getByRole("navigation", {
    name: "Личный кабинет CityGo",
  });
  const message = page.getByRole("textbox", {
    name: "Сообщение помощнику",
    exact: true,
  });
  await expect(navigation).toBeVisible();
  await expect(message).toBeEnabled();
  await originalLogo(page);
  if ((page.viewportSize()?.width ?? 1440) >= 1200) {
    const assistant = page.locator(".conversation-context:visible img");
    await decodedOriginalAsset(assistant, "/figma/support-assistant.png");
    await visibleAssetSize(assistant, 240, 240);
    const sidebar = page.locator(".conversation-topics:visible img");
    await decodedOriginalAsset(sidebar, "/figma/support-assistant.png");
    await visibleAssetSize(sidebar, 64, 64);
  }
  await privateText(page, question);
  await privateText(page, answer);
  await noHorizontalOverflow(page);
  expect(
    await message.evaluate((node) =>
      node.classList.contains("ym-disable-keys"),
    ),
  ).toBe(true);

  await message.fill("Неотправленный черновик о следующем шаге");
  await expect(message).toBeFocused();
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  await expect(send).toBeEnabled();
  await message.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport();
  await expect(navigation).toBeInViewport();
  if ((page.viewportSize()?.width ?? 1440) < 600) {
    const box = await message.locator("xpath=ancestor::form").boundingBox();
    const nav = await navigation.boundingBox();
    expect(box).not.toBeNull();
    expect(nav).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y + 1);
  }
  await page.screenshot({
    path: info.outputPath("prototype-chat.png"),
    fullPage: true,
  });

  const planButton = navigation.getByRole("button", {
    name: "Мой план",
    exact: true,
  });
  await planButton.focus();
  await page.keyboard.press("Enter");
  const planPanel = page.getByRole("region", {
    name: "Мой план переезда",
    exact: true,
  });
  await expect(planPanel).toBeVisible();
  await expect(planButton).toHaveAttribute("aria-pressed", "true");
  await privateText(page, plan[0]!.title);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: info.outputPath("prototype-plan.png"),
    fullPage: true,
  });

  const profileButton = navigation.getByRole("button", {
    name: "Профиль",
    exact: true,
  });
  await profileButton.focus();
  await page.keyboard.press("Enter");
  const profile = page.getByRole("region", {
    name: "Личный кабинет",
    exact: true,
  });
  await expect(profile).toBeVisible();
  await privateText(page, email);
  await expect(
    profile.getByRole("button", { name: "Телефон и подарок", exact: true }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: info.outputPath("prototype-profile.png"),
    fullPage: true,
  });

  await navigation
    .getByRole("button", { name: "Помощники", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Каталог помощников", exact: true }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await catalogOriginalAssets(page);
  await page.screenshot({
    path: info.outputPath("prototype-directory.png"),
    fullPage: true,
  });

  await navigation
    .getByRole("button", { name: "Диалоги", exact: true })
    .click();
  await page
    .getByRole("article", { name: "Переезд в Москву", exact: true })
    .getByRole("button", { name: "Открыть разговор", exact: true })
    .click();
  await expect(message).toHaveValue("Неотправленный черновик о следующем шаге");
  await expect(
    page.getByRole("button", { name: "Отправить", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("prototype registration fits the viewport and keeps credential keystrokes private", async ({
  page,
  context,
}, info) => {
  const state = await install(context, false);
  await page.goto("/");
  const emailInput = page.getByRole("textbox", {
    name: "Электронная почта",
    exact: true,
  });
  await expect(emailInput).toBeVisible();
  await originalLogo(page, true);
  await emailInput.focus();
  await expect(emailInput).toBeFocused();
  expect(
    await emailInput.evaluate((node) =>
      node.classList.contains("ym-disable-keys"),
    ),
  ).toBe(true);
  await expect(page.getByRole("checkbox")).toHaveCount(2);
  await noHorizontalOverflow(page);
  await page.screenshot({
    path: info.outputPath("prototype-registration.png"),
    fullPage: true,
  });
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
