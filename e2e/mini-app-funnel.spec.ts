import { expect, test } from "@playwright/test";

const platforms = {
  telegram: {
    fragment: "tgWebAppData",
    script: "https://telegram.org/js/telegram-web-app.js?65",
    attach: "window.Telegram = { WebApp: sdk }",
  },
  max: {
    fragment: "WebAppData",
    script: "https://st.max.ru/js/max-web-app.js",
    attach: "window.WebApp = sdk",
  },
};

for (const [provider, platform] of Object.entries(platforms)) {
  test(`${provider} guest sends anonymous launch and task signals to real API`, async ({
    page,
  }) => {
    const path = `/mini/${provider}`;
    const url = `/api/v1/mini-apps/${provider}/funnel`;
    const canary = "synthetic-do-not-send-launch";
    const calls: string[] = [];
    await page.route(platform.script, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `const sdk = { initData: "${canary}", openLink() {} }; ${platform.attach};`,
      }),
    );
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        calls.push(new URL(request.url()).pathname);
    });
    await page.goto(path);
    await page.getByRole("button", { name: /Найти жильё/ }).click();
    await expect(
      page.getByRole("heading", { name: "Поиск жилья" }),
    ).toBeVisible();
    expect(calls).toEqual([]);

    await page.goto("about:blank");
    const launched = page.waitForResponse((response) =>
      response.url().endsWith(url),
    );
    await page.goto(`${path}#${platform.fragment}=${canary}`);
    const launchResponse = await launched;
    expect(launchResponse.status()).toBe(204);
    expect(launchResponse.request().postDataJSON()).toEqual({
      event: "launch",
    });
    expect(await launchResponse.request().headerValue("cookie")).toBeNull();
    expect(await launchResponse.request().headerValue("referer")).toBeNull();
    await expect(page).toHaveURL(new RegExp(`${path}$`));

    const chosen = page.waitForResponse((response) =>
      response.url().endsWith(url),
    );
    await page.getByRole("button", { name: /Найти жильё/ }).click();
    const choiceResponse = await chosen;
    expect(choiceResponse.status()).toBe(204);
    expect(choiceResponse.request().postDataJSON()).toEqual({
      event: "task_selected",
    });
    expect(calls).toEqual([url, url]);
  });
}
