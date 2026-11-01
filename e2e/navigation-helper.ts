import { expect, type Locator, type Page } from "@playwright/test";

/** Follow the same disclosure menus as a user; never force hidden controls. */
export async function openAccountMenu(page: Page) {
  const menu = page.locator("details.account-menu");
  await expect(menu).toBeVisible();
  if ((await menu.getAttribute("open")) === null)
    await menu.locator(":scope > summary").click();
}

export async function clickAccountAction(page: Page, name: string) {
  await openAccountMenu(page);
  await page
    .locator("details.account-menu")
    .getByRole("button", { name, exact: true })
    .click();
}

export async function openWalletMenu(page: Page) {
  const menu = page.locator("#citygo-account-overview details");
  await expect(menu).toBeVisible();
  if ((await menu.getAttribute("open")) === null)
    await menu.getByText("Ещё", { exact: true }).click();
}

export async function clickWalletAction(page: Page, name: string) {
  await openWalletMenu(page);
  await page
    .getByRole("region", { name: "Баланс и телефон", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}

export async function openConversationTools(page: Page) {
  const tools = page.locator("details.conversation-tools");
  await expect(tools).toBeVisible();
  if ((await tools.getAttribute("open")) === null)
    await tools.getByText("Действия с диалогом", { exact: true }).click();
}

export async function openResults(page: Page) {
  const direct = page.getByRole("button", { name: "Результаты", exact: true });
  if (await direct.isVisible()) {
    await direct.click();
  } else {
    await page.getByRole("button", { name: "Профиль", exact: true }).click();
    await page
      .getByRole("button", { name: "Открыть результаты", exact: true })
      .click();
  }
}

export async function openLegacyMap(page: Page) {
  await clickAccountAction(page, "Карта пути");
  await expect(
    page.getByRole("navigation", {
      name: "Навигация по переезду",
      exact: true,
    }),
  ).toBeVisible();
}

export async function openMessageActions(article: Locator) {
  const actions = article.locator("details.conversation-message-extras");
  await expect(actions).toBeVisible();
  if ((await actions.getAttribute("open")) === null)
    await actions.getByText("Ещё", { exact: true }).click();
}
