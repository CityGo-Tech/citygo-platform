import { openAccountMenu } from "./navigation-helper";
import { fulfillProductAnalytics } from "./product-analytics-fixture";
import { expect, test, type Page } from "@playwright/test";
import type { Dashboard, ServiceConsentPolicy } from "@citygo/contracts";
import { syntheticConsentPolicy } from "./service-consent-fixture";

async function fixture(page: Page, gated = false) {
  const state = {
    authenticated: gated,
    owner: "101",
    required: gated,
    marketing: false,
    version: syntheticConsentPolicy.version,
    missingPolicy: false,
    registration: [] as unknown[],
    choices: [] as unknown[],
    serviceReads: [] as string[],
    unexpected: [] as string[],
    delaySave: false,
    releaseSave: () => {},
    savedDelivered: Promise.resolve(),
  };
  const saveGate = new Promise<void>((resolve) => {
    state.releaseSave = resolve;
  });
  let savedDelivered = () => {};
  state.savedDelivered = new Promise<void>((resolve) => {
    savedDelivered = resolve;
  });
  const policy = () => ({ ...syntheticConsentPolicy, version: state.version });
  const user = () => ({
    id: state.owner,
    email: state.owner + "@example.test",
    serviceConsentRequired: state.required,
  });
  const board = (): Dashboard => ({
    user: user(),
    profile: null,
    quests: [],
    xp: 0,
    thread: state.required
      ? {
          id: "10",
          agentKey: "support",
          messages: [
            {
              id: "1",
              role: "user",
              agentKey: "support",
              status: "complete",
              content: "PRIVATE_BEFORE_CONSENT",
            },
          ],
        }
      : null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  });
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillProductAnalytics(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard")
      return route.fulfill({
        status: state.authenticated ? 200 : 401,
        json: state.authenticated ? board() : { error: "Войдите" },
      });
    if (path === "/api/v1/auth/registration-policy")
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          ...(state.missingPolicy ? {} : { consentPolicy: policy() }),
        },
      });
    if (path === "/api/v1/auth/register") {
      state.registration.push(route.request().postDataJSON());
      state.authenticated = true;
      return route.fulfill({ json: { user: user() } });
    }
    if (path === "/api/v1/account/consents") {
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        const owner = state.owner;
        state.choices.push(input);
        if (state.delaySave) await saveGate;
        if (owner === state.owner) {
          state.required = false;
          state.marketing = input.marketing;
        }
        try {
          return await route.fulfill({
            json: {
              policy: policy(),
              personalDataGranted: true,
              marketingGranted: input.marketing,
              serviceConsentRequired: false,
            },
          });
        } catch {
          // The old owner's response can be cancelled after the account changes.
        } finally {
          savedDelivered();
        }
        return;
      }
      return route.fulfill({
        json: {
          policy: policy(),
          personalDataGranted: !state.required,
          marketingGranted: state.marketing,
          serviceConsentRequired: state.required,
        },
      });
    }
    if (
      path.startsWith("/api/v1/conversations/") ||
      path.includes("/messages") ||
      path.includes("/payments/")
    ) {
      state.serviceReads.push(path);
      return route.fulfill({
        status: 403,
        json: { error: "Service gate", code: "SERVICE_CONSENT_REQUIRED" },
      });
    }
    state.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}
const mandatory = (page: Page) =>
  page.locator("input[name=personalDataConsent]");
const marketing = (page: Page) => page.locator("input[name=marketingConsent]");

test("public documents use the current API snapshot and never substitute a stale built-in document on load failure", async ({
  page,
}) => {
  let revision = "synthetic-current-A";
  let failed = false;
  await page.route("**/api/v1/legal/consent-policy", (route) =>
    failed
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.fulfill({
          json: {
            ...syntheticConsentPolicy,
            version: revision,
            personalData: {
              ...syntheticConsentPolicy.personalData,
              text: "CURRENT_API_DOCUMENT_" + revision,
            },
          },
        }),
  );
  await page.goto("/legal/personal-data-consent");
  const document = page.getByRole("article");
  await expect(document).toContainText(
    "CURRENT_API_DOCUMENT_synthetic-current-A",
  );
  failed = true;
  await page.reload();
  await expect(document.getByRole("alert")).toContainText(
    "Не удалось загрузить актуальный документ",
  );
  await expect(document).not.toContainText("CURRENT_API_DOCUMENT_");
  await expect(document).not.toContainText(
    syntheticConsentPolicy.personalData.text,
  );
  failed = false;
  revision = "synthetic-current-B";
  await document
    .getByRole("button", { name: "Обновить документ", exact: true })
    .click();
  await expect(document).toContainText(
    "CURRENT_API_DOCUMENT_synthetic-current-B",
  );
  await expect(document).not.toContainText(
    "CURRENT_API_DOCUMENT_synthetic-current-A",
  );
});

test("both consent documents are readable before login and unknown documents return404", async ({
  page,
}) => {
  const policyResponse = await page.request.get("/api/v1/legal/consent-policy");
  expect(policyResponse.ok()).toBe(true);
  const serviceConsentPolicy =
    (await policyResponse.json()) as ServiceConsentPolicy;
  for (const document of [
    serviceConsentPolicy.personalData,
    serviceConsentPolicy.marketing,
  ]) {
    const response = await page.goto(document.url);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("article").locator("p")).toHaveText([
      "Редакция " + serviceConsentPolicy.version,
      ...document.text.split("\n\n"),
    ]);
    await expect(
      page.getByText("Редакция " + serviceConsentPolicy.version, {
        exact: true,
      }),
    ).toBeVisible();
  }
  const missing = await page.goto("/legal/synthetic-unknown-document");
  expect(missing?.status()).toBe(404);
});

test("signup has two independent unchecked choices and sends an explicit optional refusal", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.goto("/");
  await expect(mandatory(page)).not.toBeChecked();
  await expect(marketing(page)).not.toBeChecked();
  await expect(mandatory(page)).toHaveAttribute("required", "");
  await expect(marketing(page)).not.toHaveAttribute("required", "");
  await expect(
    page.getByText("Читать согласие на обработку данных", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Читать согласие на рассылку", { exact: true }),
  ).toBeVisible();
  await page
    .getByText("Читать согласие на обработку данных", { exact: true })
    .click();
  await expect(
    page.getByRole("article", {
      name: syntheticConsentPolicy.personalData.label,
      exact: true,
    }),
  ).toContainText(syntheticConsentPolicy.personalData.text);
  await expect(marketing(page).locator("..")).not.toContainText("*");
  await page.screenshot({
    path: info.outputPath("registration-consents.png"),
    fullPage: true,
  });
  const create = page.getByRole("button", {
    name: "Создать аккаунт",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await marketing(page).check();
  await expect(create).toBeDisabled();
  await marketing(page).uncheck();
  await mandatory(page).check();
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("synthetic@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  await create.click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(state.registration).toEqual([
    {
      email: "synthetic@example.test",
      password: "123456",
      consents: {
        policyVersion: syntheticConsentPolicy.version,
        personalData: true,
        marketing: false,
      },
    },
  ]);
  expect(state.choices).toEqual([]);
  const storage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  expect(storage).not.toContain("policyVersion");
  expect(state.unexpected).toEqual([]);
});

test("a changed displayed version requires a fresh choice and never registers automatically", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await mandatory(page).check();
  await marketing(page).check();
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("synthetic@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  state.version = "synthetic-new-version";
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(page.locator(".alert")).toContainText("Согласия обновились");
  expect(state.registration).toEqual([]);
  await expect(mandatory(page)).not.toBeChecked();
  await expect(marketing(page)).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeDisabled();
});

test("missing policy fails closed until an explicit refresh succeeds", async ({
  page,
}) => {
  const state = await fixture(page);
  state.missingPolicy = true;
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Обновить согласия" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toBeDisabled();
  expect(state.registration).toEqual([]);
  state.missingPolicy = false;
  await page.getByRole("button", { name: "Обновить согласия" }).click();
  await expect(mandatory(page)).not.toBeChecked();
});

test("existing account gate hides private service views and requires explicit acceptance before restoring access", async ({
  page,
}) => {
  const state = await fixture(page, true);
  await page.addInitScript(() =>
    localStorage.setItem("citygo:conversation:101", "10"),
  );
  await page.goto("/#chat");
  await expect(
    page.getByRole("heading", { name: "Согласие для работы сервиса" }),
  ).toBeVisible();
  await expect(mandatory(page)).not.toBeChecked();
  await expect(marketing(page)).not.toBeChecked();
  await expect(page.getByText("PRIVATE_BEFORE_CONSENT")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Мои чеки", exact: true }),
  ).toHaveCount(0);
  await openAccountMenu(page);
  await expect(
    page.getByRole("button", { name: "Пароль", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeVisible();
  expect(state.serviceReads).toEqual([]);
  expect(state.choices).toEqual([]);
  await mandatory(page).check();
  await page
    .getByRole("button", { name: "Принять и продолжить", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(state.choices).toEqual([
    {
      policyVersion: syntheticConsentPolicy.version,
      personalData: true,
      marketing: false,
    },
  ]);
  expect(state.serviceReads).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("an accepted account has no persistent consent settings or first-send dialog", async ({
  page,
}) => {
  const state = await fixture(page, true);
  state.required = false;
  state.marketing = true;
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Согласия", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(marketing(page)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(state.choices).toEqual([]);
  expect(state.required).toBe(false);
});

test("owner replacement clears unchecked gate choices and ignores a late acceptance", async ({
  page,
}) => {
  const state = await fixture(page, true);
  state.delaySave = true;
  try {
    await page.goto("/");
    await mandatory(page).check();
    await marketing(page).check();
    await page
      .getByRole("button", { name: "Принять и продолжить", exact: true })
      .click();
    await expect.poll(() => state.choices.length).toBe(1);
    state.owner = "202";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(mandatory(page)).not.toBeChecked();
    await expect(marketing(page)).not.toBeChecked();
    state.releaseSave();
    await state.savedDelivered;
    await expect(
      page.getByRole("heading", { name: "Согласие для работы сервиса" }),
    ).toBeVisible();
    await expect(
      page.getByText("Условия приняты. Можно продолжить работу."),
    ).toHaveCount(0);
  } finally {
    state.releaseSave();
  }
});
