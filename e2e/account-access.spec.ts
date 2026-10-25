import { syntheticConsentPolicy } from "./service-consent-fixture";
import { test, expect, type Page } from "@playwright/test";
import type {
  AccountUser,
  AiControlStatus,
  Dashboard,
} from "@citygo/contracts";

const owner: AccountUser = {
  id: "1",
  email: "admin@citygo.invalid",
  username: "admin",
  role: "super_admin",
  mustChangePassword: false,
};
const participant: AccountUser = {
  id: "2",
  email: "participant@example.test",
  username: null,
  role: "user",
  mustChangePassword: false,
};
function dashboard(user: AccountUser): Dashboard {
  return {
    user,
    profile: null,
    quests: [],
    xp: 0,
    thread: null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  };
}
const ai: AiControlStatus = {
  current: { provider: "disabled", policyId: null, revision: 1 },
  effectiveProvider: "unconfigured",
  environmentDisabled: false,
  automaticFallback: false,
  options: [],
  audit: [],
};

test("bootstrap password gate hides the conversation and privileged links until a six-character password is saved", async ({
  page,
}) => {
  const state = { user: { ...owner, mustChangePassword: true } };
  const writes: unknown[] = [];
  const unexpected: string[] = [];
  // Every application API request is intercepted: no real accounts, database,
  // credentials or AI provider can be reached by this browser test.
  await page.route("**/api/v1/**", async (route) => {
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).origin === "http://localhost:3000" &&
      new URL(route.request().url()).pathname ===
        "/api/v1/auth/registration-policy"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard")
      return route.fulfill({ json: dashboard(state.user) });
    if (
      path === "/api/v1/auth/password" &&
      route.request().method() === "POST"
    ) {
      writes.push(route.request().postDataJSON());
      state.user = { ...state.user, mustChangePassword: false };
      return route.fulfill({ json: { user: state.user } });
    }
    unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Изменить пароль", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Временный пароль нужно заменить", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Сообщение помощнику")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Начать диалог", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Помощники", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Открыть админку сервиса", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Текущий пароль", { exact: true }).fill("admin");
  const password = page.getByLabel("Новый пароль", { exact: true });
  await password.fill("12345");
  await page
    .getByRole("button", { name: "Сохранить новый пароль", exact: true })
    .click();
  expect(writes).toEqual([]);
  expect(
    await password.evaluate(
      (element: HTMLInputElement) => element.validity.tooShort,
    ),
  ).toBeTruthy();
  const newPassword = " аа!  ";
  await password.fill(newPassword);
  await page
    .getByRole("button", { name: "Сохранить новый пароль", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Пароль изменён");
  await expect(
    page.getByRole("heading", { name: "Давайте начнём с того, что волнует" }),
  ).toBeVisible();
  expect(writes).toEqual([{ currentPassword: "admin", password: newPassword }]);
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Открыть админку сервиса", exact: true }),
  ).toBeVisible();
  expect(unexpected).toEqual([]);
});

async function adminFixture(page: Page, viewer: AccountUser) {
  const state = {
    viewer,
    users: [{ ...owner }, { ...participant }],
    accountReads: 0,
    roleWrites: [] as { userId: string; role: string }[],
    unexpected: [] as string[],
    delaySecond: false,
    release: () => {},
    delivered: Promise.resolve(),
  };
  let deliver: () => void = () => {};
  const delayed = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  state.delivered = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  await page.route("**/api/v1/**", async (route) => {
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).origin === "http://localhost:3000" &&
      new URL(route.request().url()).pathname ===
        "/api/v1/auth/registration-policy"
    )
      return route.fulfill({
        json: {
          emailVerification: "disabled",
          consentPolicy: syntheticConsentPolicy,
        },
      });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard")
      return route.fulfill({ json: dashboard(state.viewer) });
    if (path === "/api/v1/admin/overview")
      return route.fulfill({
        json: { counts: { users: 2, completed: 0, xp: 0 }, pendingHuman: [] },
      });
    if (path === "/api/v1/admin/ai") return route.fulfill({ json: ai });
    if (path === "/api/v1/admin/accounts") {
      state.accountReads++;
      if (state.viewer.role !== "super_admin")
        return route.fulfill({
          status: 403,
          json: { error: "Требуются права super admin" },
        });
      return route.fulfill({ json: { users: state.users } });
    }
    if (
      path === "/api/v1/admin/accounts/role" &&
      route.request().method() === "POST"
    ) {
      const input = route.request().postDataJSON() as {
        userId: string;
        role: "user" | "admin" | "super_admin";
      };
      state.roleWrites.push(input);
      const late = state.delaySecond && state.roleWrites.length === 2;
      if (late) await delayed;
      const user = { ...participant, role: input.role };
      state.users = state.users.map((current) =>
        current.id === input.userId ? user : current,
      );
      try {
        await route.fulfill({ json: { user } });
      } catch {
        /* The invalidated browser is allowed to cancel this old response. */
      } finally {
        if (late) deliver();
      }
      return;
    }
    state.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  return state;
}

test("super admin confirms a specific role change and a delayed old-session response cannot republish controls", async ({
  page,
}) => {
  const state = await adminFixture(page, { ...owner });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Обновить сводку", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Аккаунты и роли", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Новая роль для admin", { exact: true }),
  ).toBeDisabled();
  const row = page
    .getByRole("heading", { level: 3, name: participant.email, exact: true })
    .locator("..");
  const selection = page.getByLabel(`Новая роль для ${participant.email}`, {
    exact: true,
  });
  const save = row.getByRole("button", { name: "Сохранить роль", exact: true });
  const confirm = page.getByRole("checkbox", {
    name: "Подтверждаю изменение роли аккаунта 2",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await selection.selectOption("admin");
  await expect(save).toBeDisabled();
  await confirm.check();
  await selection.selectOption("super_admin");
  await expect(confirm).not.toBeChecked();
  await expect(save).toBeDisabled();
  await selection.selectOption("admin");
  await confirm.check();
  await save.click();
  await expect(page.getByRole("status")).toHaveText(
    "Роль аккаунта 2 сохранена.",
  );
  await expect(selection).toHaveValue("admin");
  await expect(confirm).not.toBeChecked();
  await expect(save).toBeDisabled();
  expect(state.roleWrites).toEqual([{ userId: "2", role: "admin" }]);
  expect(state.accountReads).toBe(2);

  state.delaySecond = true;
  await selection.selectOption("super_admin");
  await confirm.check();
  await save.click();
  await expect.poll(() => state.roleWrites.length).toBe(2);
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "citygo-session-changed",
        newValue: "synthetic-account-change",
      }),
    ),
  );
  await expect(row).toHaveCount(0);
  const readsBeforeRelease = state.accountReads;
  state.release();
  await state.delivered;
  await expect(
    page.getByRole("heading", { name: "Аккаунты и роли", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Роль аккаунта 2 сохранена.", { exact: true }),
  ).toHaveCount(0);
  expect(state.roleWrites).toEqual([
    { userId: "2", role: "admin" },
    { userId: "2", role: "super_admin" },
  ]);
  expect(state.accountReads).toBe(readsBeforeRelease);
  expect(state.unexpected).toEqual([]);
});

test("ordinary admin can view the overview but never requests the super-admin account list", async ({
  page,
}) => {
  const state = await adminFixture(page, {
    ...owner,
    id: "3",
    username: "ordinary-admin",
    email: "ordinary-admin@example.test",
    role: "admin",
  });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Обновить сводку", exact: true })
    .click();
  await expect(
    page.getByText("Пользователей: 2", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Ваши права администратора не позволяют выдавать роли.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByLabel(/Новая роль для/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Сохранить роль", exact: true }),
  ).toHaveCount(0);
  expect(state.accountReads).toBe(0);
  expect(state.roleWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
