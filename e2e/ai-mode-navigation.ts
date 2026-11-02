import { expect, type Page } from "@playwright/test";
import type { AiModeId } from "@citygo/contracts";
import { aiModeLabels } from "../packages/contracts/src/ai-modes";

export const modeSelector = (page: Page) =>
  page
    .locator(".conversation-mode-bar")
    .getByRole("button", { name: "Режим работы", exact: true });
export const modePicker = (page: Page) =>
  page
    .locator(".conversation-mode-bar")
    .getByRole("dialog", { name: "Режим работы", exact: true });
export async function openModePicker(page: Page) {
  if (!(await modePicker(page).isVisible())) await modeSelector(page).click();
  await expect(modePicker(page)).toBeVisible();
  return modePicker(page);
}
export async function chooseMode(page: Page, mode: AiModeId) {
  const picker = await openModePicker(page);
  await picker
    .getByRole("button", { name: aiModeLabels[mode], exact: true })
    .click();
  await expect(picker).not.toBeVisible();
}
