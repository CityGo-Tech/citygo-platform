import { expect, test } from "@playwright/test";
import type {
  AccountUser,
  AiControlStatus,
  Dashboard,
} from "@citygo/contracts";

const owner: AccountUser = {
  id: "1",
  email: "owner@example.test",
  username: "admin",
  role: "super_admin",
  mustChangePassword: false,
};
const control: AiControlStatus = {
  current: { provider: "disabled", policyId: null, revision: 1 },
  effectiveProvider: "unconfigured",
  environmentDisabled: false,
  automaticFallback: false,
  options: [],
  audit: [],
};
const first = Array.from({ length: 50 }, (_, i) => ({
  userId: String(i + 2),
  email: `synthetic${i}@example.test`,
  username: null,
  phone: "+79000000001",
  verifiedAt: "2026-10-28T00:00:00.000Z",
}));
const last = {
  userId: "52",
  email: "last@example.test",
  username: null,
  phone: "+79000000002",
  verifiedAt: "2026-10-28T00:00:00.000Z",
};

test("super admin explicitly views customer phones and pages without retaining the old page", async ({
  page,
}) => {
  let role = "super_admin";
  let requests = 0;
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/dashboard") {
      const dashboard: Dashboard = {
        user: { ...owner, role: role as AccountUser["role"] },
        profile: null,
        quests: [],
        xp: 0,
        thread: null,
        provider: "unconfigured",
        aiAccess: { policy: null, granted: false, dailyLimit: 0 },
      };
      return route.fulfill({ json: dashboard });
    }
    if (url.pathname === "/api/v1/admin/overview")
      return route.fulfill({
        json: { counts: { users: 52, completed: 0, xp: 0 }, pendingHuman: [] },
      });
    if (url.pathname === "/api/v1/admin/ai")
      return route.fulfill({ json: control });
    if (url.pathname === "/api/v1/admin/accounts")
      return route.fulfill({ json: { users: [owner] } });
    if (url.pathname === "/api/v1/admin/phone-contacts") {
      requests++;
      return route.fulfill({
        json: url.searchParams.has("afterUserId")
          ? { contacts: [last], nextAfterUserId: null }
          : { contacts: first, nextAfterUserId: "51" },
      });
    }
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "Показать клиентскую базу" }).click();
  await expect(page.getByText(first[0]!.phone, { exact: true })).toHaveCount(
    50,
  );
  await page.getByRole("button", { name: "Следующие телефоны" }).click();
  await expect(page.getByText(last.phone, { exact: true })).toBeVisible();
  await expect(page.getByText(first[0]!.phone, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Предыдущие телефоны" }).click();
  await expect(page.getByText(first[0]!.phone, { exact: true })).toHaveCount(
    50,
  );
  await page.getByRole("button", { name: "Скрыть номера" }).click();
  await expect(
    page.getByRole("list", { name: "Подтверждённые телефоны клиентов" }),
  ).toHaveCount(0);
  role = "admin";
  await page.getByRole("button", { name: "Показать клиентскую базу" }).click();
  await expect(
    page.getByRole("heading", { name: "Клиентская база" }),
  ).toHaveCount(0);
  expect(requests).toBe(3);
});

test("a late customer-phone response cannot reveal numbers after session change", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/dashboard")
      return route.fulfill({
        json: {
          user: owner,
          profile: null,
          quests: [],
          xp: 0,
          thread: null,
          provider: "unconfigured",
          aiAccess: { policy: null, granted: false, dailyLimit: 0 },
        },
      });
    if (path === "/api/v1/admin/overview")
      return route.fulfill({
        json: { counts: { users: 2, completed: 0, xp: 0 }, pendingHuman: [] },
      });
    if (path === "/api/v1/admin/ai") return route.fulfill({ json: control });
    if (path === "/api/v1/admin/accounts")
      return route.fulfill({ json: { users: [owner] } });
    if (path === "/api/v1/admin/phone-contacts") {
      requested = true;
      await gate;
      return route.fulfill({
        json: { contacts: [last], nextAfterUserId: null },
      });
    }
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected synthetic request" },
    });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Обновить сводку" }).click();
  await page.getByRole("button", { name: "Показать клиентскую базу" }).click();
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "citygo-session-changed",
        newValue: "synthetic-new-session",
      }),
    ),
  );
  release();
  await expect(
    page.getByRole("heading", { name: "Клиентская база" }),
  ).toHaveCount(0);
  await expect(page.getByText(last.phone, { exact: true })).toHaveCount(0);
});
