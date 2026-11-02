import { expect, test } from "@playwright/test";
import { fixture, noOtherTraffic } from "./ai-mode-fixture";
import { chooseMode, modeSelector } from "./ai-mode-navigation";

test("right mode picker uses the same preference, draft and focus without a duplicate ID or automatic send", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/");
  const rail = page.locator(".conversation-context").filter({ visible: true });
  if (page.viewportSize()!.width <= 1000) {
    await expect(rail).toHaveCount(0);
    await expect(modeSelector(page)).toHaveAttribute("data-ai-mode", "maximum");
    noOtherTraffic(state);
    return;
  }
  const inline = modeSelector(page);
  const right = rail.getByRole("button", { name: "Режим работы", exact: true });
  await expect(right).toHaveAttribute("data-ai-mode", "maximum");
  expect(await right.getAttribute("aria-controls")).not.toBe(
    await inline.getAttribute("aria-controls"),
  );
  const composer = page.getByLabel("Сообщение помощнику", { exact: true });
  await composer.fill("ЧЕРНОВИК_ИЗ_ПРАВОЙ_КОЛОНКИ");
  await right.click();
  const picker = rail.getByRole("dialog", {
    name: "Режим работы",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Режим работы", exact: true }),
  ).toHaveCount(1);
  await expect(
    picker.getByText("Сложные вопросы и подробный разбор вариантов.", {
      exact: true,
    }),
  ).toBeVisible();
  await picker.getByRole("button", { name: "Баланс", exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(right).toBeFocused();
  await expect(right).toHaveAttribute("data-ai-mode", "balanced");
  await expect(inline).toHaveAttribute("data-ai-mode", "balanced");
  await chooseMode(page, "minimum");
  await expect(right).toHaveAttribute("data-ai-mode", "minimum");
  await right.click();
  await page.keyboard.press("Escape");
  await expect(right).toBeFocused();
  await expect(composer).toHaveValue("ЧЕРНОВИК_ИЗ_ПРАВОЙ_КОЛОНКИ");
  await expect(
    page.getByRole("log", { name: "История диалога" }),
  ).toContainText("СОХРАНЁННЫЙ_ОТВЕТ");
  expect(state.sends).toEqual([]);
  expect(state.consentSaves).toEqual([]);
  noOtherTraffic(state);
});
