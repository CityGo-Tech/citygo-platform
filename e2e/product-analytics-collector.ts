import { paidCollector } from "./paid-pixels-collector";
import { expect, type Page } from "@playwright/test";

export const analyticsOrigin = "https://pilot.xn--c1ajazlh.xn--p1ai";
export const enabledCollector = () =>
  process.env.CITYGO_METRIKA_E2E_ENABLED === "enabled";
export type CollectorCommand = [number, string, ...unknown[]];

/** Real local built HTML/assets, strict synthetic APIs, delayed fake SDK only. */
export async function delayedCollector(page: Page) {
  const paid = await paidCollector(page);
  let sdkRequests = 0;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.context().route(analyticsOrigin + "/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    expect(url.origin).toBe(analyticsOrigin);
    expect(request.method()).toBe("GET");
    const response = await page.request.get(
      "http://localhost:3000" + url.pathname + url.search,
      { maxRedirects: 0 },
    );
    await route.fulfill({ response });
  });
  await page
    .context()
    .route("https://mc.yandex.ru/metrika/tag.js", async (route) => {
      sdkRequests++;
      expect(route.request().method()).toBe("GET");
      await gate;
      try {
        await route.fulfill({
          contentType: "application/javascript",
          body: `(() => {
        const pending=window.ym&&window.ym.a||[];
        window.ym=(...args)=>{
          const rows=JSON.parse(localStorage.getItem('__citygo_late_collector')||'[]');
          rows.push(args);localStorage.setItem('__citygo_late_collector',JSON.stringify(rows));
        };
        pending.forEach(args=>window.ym(...args));
      })();`,
        });
      } catch {
        /* A departed route must not revive the old recorder. */
      }
    });
  const commands = () =>
    page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("__citygo_late_collector") ?? "[]",
        ) as CollectorCommand[],
    );
  return {
    release,
    paid,
    sdkRequests: () => sdkRequests,
    commands,
    goals: async () =>
      (await commands())
        .filter((row) => row[1] === "reachGoal")
        .map((row) => row[2]),
  };
}
