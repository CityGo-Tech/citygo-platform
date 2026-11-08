import { expect, type Page } from "@playwright/test";

const origin = "https://pilot.xn--c1ajazlh.xn--p1ai";
export const paidPixelsEnabled = () =>
  process.env.CITYGO_AD_PIXELS_E2E_ENABLED === "enabled";
type PaidCommand = {
  provider: "vk" | "avito";
  command: Record<string, unknown>;
  url: string;
  referrer: string;
};

/** All provider traffic is synthetic and is rejected unless explicitly mocked. */
export async function paidCollector(page: Page) {
  const commands: PaidCommand[] = [];
  let sdkRequests = 0;
  for (const provider of ["vk", "avito"] as const) {
    const source =
      provider === "vk"
        ? "https://top-fwz1.mail.ru/js/code.js"
        : "https://ac.avito.ru/tag.js";
    const transport =
      provider === "vk"
        ? "https://top-fwz1.mail.ru/__citygo_paid_test"
        : "https://www.avito.ru/__citygo_paid_test";
    await page.context().route(transport, async (route) => {
      expect(route.request().method()).toBe("POST");
      commands.push(route.request().postDataJSON());
      await route.fulfill({
        json: { accepted: true },
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
        },
      });
    });
    await page.context().route(source, async (route) => {
      sdkRequests++;
      expect(route.request().frame().parentFrame()).not.toBeNull();
      await route.fulfill({
        contentType: "application/javascript",
        body: `(() => {
        const send=command=>void fetch(${JSON.stringify(transport)},{method:'POST',body:JSON.stringify({provider:${JSON.stringify(provider)},command,url:location.href,referrer:document.referrer})}).catch(()=>{});
        ${provider === "vk" ? `const pending=window._tmr||[];window._tmr={push:send};pending.forEach(send);` : `const initial=window._apxl;send({type:'pageView',id:initial[0].id});window._apxl={sendEvent:command=>send({...command,id:initial[0].id})};(initial.q||[]).forEach(row=>window._apxl.sendEvent(row[0]));`}
      })();`,
      });
    });
  }
  return {
    commands,
    sdkRequests: () => sdkRequests,
    goals: () =>
      commands
        .filter((row) => row.command.type === "reachGoal")
        .map(
          (row) =>
            row.provider + ":" + (row.command.goal ?? row.command.goalName),
        )
        .sort(),
  };
}
