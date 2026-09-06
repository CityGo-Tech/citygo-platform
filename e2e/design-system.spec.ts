import { test, expect } from "@playwright/test";

test("shared components expose keyboard, error and disabled states", async ({
  page,
}, testInfo) => {
  await page.goto("/design-system");
  await expect(
    page.getByRole("heading", { name: "Компоненты CityGo" }),
  ).toBeVisible();
  const city = page.getByLabel("Город", { exact: true });
  await expect(city).toHaveAccessibleDescription("Название города отправления");
  await city.focus();
  expect(
    await city.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe("solid");
  await expect(
    page.getByLabel("Поле с ошибкой", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByLabel("Поле с ошибкой", { exact: true }),
  ).toHaveAccessibleDescription("Введите минимум два символа");
  await expect(
    page.getByRole("button", { name: "Недоступное действие" }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Недоступное поле", { exact: true }),
  ).toBeDisabled();
  const solo = page.getByRole("radio", { name: "Один", exact: true });
  await solo.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "С партнёром", exact: true }),
  ).toBeChecked();
  await expect(page.getByRole("status")).toHaveText("Выбрано: couple");
  await expect(
    page.getByRole("radio", { name: "Найти работу", exact: true }),
  ).toBeDisabled();
  for (const button of await page.getByRole("button").all())
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await page.screenshot({
    path: testInfo.outputPath("figma-components.png"),
    fullPage: true,
  });
});

test("component library fits a narrow 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/design-system");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});
