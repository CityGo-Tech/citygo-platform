import { expect, test, type Page } from "@playwright/test";
import { analyticsOrigin } from "./product-analytics-collector";

const channel = "123e4567-e89b-42d3-a456-426614174000";
const canonical =
  analyticsOrigin +
  "/landing/v1?utm_source=vk&utm_medium=cpc&utm_campaign=v1_moscow_202611&utm_content=family_square";
const parentPath = "/__synthetic_paid_pixels_parent";
const privateSentinel = "PRIVATE-CONTACT-AND-MESSAGE";

type Init = {
  type: string;
  version: number;
  channel: string;
  url: string;
  config: { vkPixelId: number | null; avitoCounterId: number | null };
};
const init = (): Init => ({
  type: "citygo-paid-init",
  version: 1,
  channel,
  url: canonical,
  config: { vkPixelId: 3812681, avitoCounterId: 3496456 },
});

type HarnessWindow = Window & { __paidMessages: unknown[] };
type Command = {
  provider: "vk" | "avito";
  command: Record<string, unknown>;
  url: string;
  referrer: string;
  title: string;
};

/** Synthetic parent; only the actual locally built frame assets are proxied.
 * Both vendor SDK destinations and every collector request are intercepted.
 * No production API, vendor event, email, SMS, AI or payment is contacted.
 */
async function harness(
  page: Page,
  options: { delaySdk?: boolean; heartbeat?: boolean; failVk?: boolean } = {},
) {
  const state = {
    sdk: [] as string[],
    commands: [] as Command[],
    unexpected: [] as string[],
    frameHeaders: {} as Record<string, string>,
  };
  let releaseSdk!: () => void;
  const gate = options.delaySdk
    ? new Promise<void>((resolve) => (releaseSdk = resolve))
    : Promise.resolve();
  if (!options.delaySdk) releaseSdk = () => {};
  const fake = (provider: "vk" | "avito") => `(() => {
    const provider=${JSON.stringify(provider)};
    const transport=provider==='vk'?'https://top-fwz1.mail.ru/__citygo_test':'https://www.avito.ru/__citygo_test';
    const send=command=>void fetch(transport,{method:'POST',body:JSON.stringify({provider,command,url:location.href,referrer:document.referrer,title:document.title})}).catch(()=>{});
    if(provider==='vk'){
      const pending=window._tmr||[];
      window._tmr={push:send};
      pending.forEach(send);
    }else{
      const pending=window._apxl;
      const id=pending[0].id;
      send({type:'pageView',id});
      window._apxl={sendEvent:command=>send({...command,id})};
      (pending.q||[]).forEach(row=>window._apxl.sendEvent(row[0]));
    }
    document.addEventListener('click',()=>send({type:'childClick'}));
    for(const key of ['pushState','replaceState']){
      const previous=history[key];
      history[key]=function(...args){const result=previous.apply(this,args);send({type:'childHistory'});return result};
    }
    ${options.heartbeat ? "setInterval(()=>send({type:'childHeartbeat'}),100);" : ""}
  })();`;
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === analyticsOrigin) {
      if (url.pathname === parentPath)
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><title>Synthetic parent</title></head><body><h1>${privateSentinel}</h1><input value="private-email@example.test"><button id="parent-action">${privateSentinel}</button><a href="/private?phone=PRIVATE-PHONE">${privateSentinel}</a><script>window.__paidMessages=[];addEventListener('message',event=>window.__paidMessages.push(event.data));</script></body></html>`,
        });
      if (
        url.pathname === "/paid-pixels/frame.html" ||
        url.pathname === "/paid-pixels/frame.js"
      ) {
        expect(request.method()).toBe("GET");
        const response = await page.request.get(
          "http://localhost:3000" + url.pathname,
          { maxRedirects: 0 },
        );
        if (url.pathname.endsWith("frame.html"))
          state.frameHeaders = response.headers();
        return route.fulfill({ response });
      }
    }
    if (
      request.url() === "https://top-fwz1.mail.ru/js/code.js" ||
      request.url() === "https://ac.avito.ru/tag.js"
    ) {
      state.sdk.push(request.url());
      if (options.failVk && url.hostname === "top-fwz1.mail.ru")
        return route.abort();
      await gate;
      try {
        return await route.fulfill({
          contentType: "application/javascript",
          body: fake(url.hostname === "ac.avito.ru" ? "avito" : "vk"),
        });
      } catch {
        // A removed frame must not be revived by a delayed script response.
        return;
      }
    }
    if (
      url.pathname === "/__citygo_test" &&
      ["www.avito.ru", "top-fwz1.mail.ru"].includes(url.hostname)
    ) {
      expect(request.method()).toBe("POST");
      state.commands.push(request.postDataJSON() as Command);
      return route.fulfill({
        contentType: "application/json",
        headers: {
          "access-control-allow-origin": analyticsOrigin,
          "access-control-allow-credentials": "true",
        },
        body: "{}",
      });
    }
    state.unexpected.push(request.url());
    return route.abort();
  });
  await page.goto(analyticsOrigin + parentPath);
  return { ...state, releaseSdk, state };
}

async function attach(page: Page) {
  await page.evaluate(async () => {
    const node = document.createElement("iframe");
    node.id = "pixel-test-frame";
    node.title = "Synthetic analytics frame";
    node.referrerPolicy = "no-referrer";
    node.setAttribute("sandbox", "allow-scripts allow-same-origin");
    node.src = "/paid-pixels/frame.html";
    await new Promise<void>((resolve) => {
      node.onload = () => resolve();
      document.body.append(node);
    });
  });
}

async function post(page: Page, message: unknown) {
  await page.evaluate((value) => {
    const node = document.querySelector<HTMLIFrameElement>("#pixel-test-frame");
    node?.contentWindow?.postMessage(value, location.origin);
  }, message);
}

async function ready(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as HarnessWindow).__paidMessages.some(
          (item) =>
            !!item &&
            typeof item === "object" &&
            "type" in item &&
            item.type === "citygo-paid-ready",
        ),
      ),
    )
    .toBe(true);
}

const registration = () => ({
  type: "citygo-paid-registration",
  version: 1,
  channel,
});

test("paid frame rejects invalid URLs, extra data, identities and sibling senders before loading SDKs", async ({
  page,
}) => {
  const { state } = await harness(page);
  await attach(page);
  for (const message of [
    null,
    [],
    { ...init(), email: "private@example.test" },
    { ...init(), version: 2 },
    { ...init(), channel: "private-owner-id" },
    { ...init(), config: null },
    { ...init(), config: { vkPixelId: "3812681", avitoCounterId: 3496456 } },
    { ...init(), config: { vkPixelId: 0, avitoCounterId: 3496456 } },
    { ...init(), config: { vkPixelId: null, avitoCounterId: null } },
    { ...init(), config: { vkPixelId: 3812681, avitoCounterId: 1e10 } },
    {
      ...init(),
      config: { ...init().config, ownerId: "101" },
    },
    { ...init(), url: "https://other.example/landing/v1" },
    { ...init(), url: analyticsOrigin + "/admin" },
    { ...init(), url: analyticsOrigin + "/?email=private@example.test" },
    { ...init(), url: analyticsOrigin + "/landing/v1#private-message" },
    {
      ...init(),
      url: analyticsOrigin + "/landing/v1?utm_content=private%40example.test",
    },
    {
      ...init(),
      url: analyticsOrigin + "/landing/v1?utm_source=vk&utm_source=avito-ads",
    },
  ])
    await post(page, message);
  // An actual same-origin sibling has the right origin, but is not the parent.
  await page.evaluate(async (message) => {
    const sibling = document.createElement("iframe");
    sibling.srcdoc =
      "<script>parent.frames[0].postMessage(" +
      JSON.stringify(message) +
      ", '*')</script>";
    await new Promise<void>((resolve) => {
      sibling.onload = () => resolve();
      document.body.append(sibling);
    });
    sibling.remove();
  }, init());
  await page.waitForTimeout(100);
  expect(state.sdk).toEqual([]);
  expect(state.commands).toEqual([]);
  expect(state.unexpected).toEqual([]);
  await expect(page.locator("#pixel-test-frame")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );
  expect(state.frameHeaders["x-frame-options"]).toBe("SAMEORIGIN");
  expect(state.frameHeaders["referrer-policy"]).toBe("no-referrer");
  expect(state.frameHeaders["content-security-policy"]).toContain(
    "frame-ancestors 'self'",
  );
  expect(state.frameHeaders["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  await post(page, init());
  await ready(page);
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.sdk).toHaveLength(2);
  expect(state.commands.every((row) => row.url === canonical)).toBe(true);
  expect(state.commands.every((row) => row.referrer === "")).toBe(true);
  await page.waitForLoadState("networkidle");
});

test("paid frame keeps SDK commands in its empty document and deduplicates init and confirmed registration", async ({
  page,
}) => {
  const { state, releaseSdk } = await harness(page, { delaySdk: true });
  await attach(page);
  await post(page, init());
  await expect.poll(() => state.sdk.length).toBe(2);
  await post(page, init());
  await post(page, {
    ...init(),
    config: { vkPixelId: 99, avitoCounterId: 88 },
  });
  await post(page, registration());
  expect(state.commands).toEqual([]);
  releaseSdk();
  await ready(page);
  await expect.poll(() => state.commands.length).toBe(2);
  await post(page, { ...registration(), channel: "wrong-channel" });
  await post(page, { ...registration(), email: "private@example.test" });
  await post(page, registration());
  await post(page, registration());
  await expect.poll(() => state.commands.length).toBe(4);
  expect(state.sdk).toHaveLength(2);
  const vk = state.commands.filter((row) => row.provider === "vk");
  const avito = state.commands.filter((row) => row.provider === "avito");
  expect(vk.map((row) => row.command.type)).toEqual(["pageView", "reachGoal"]);
  expect(vk[1]?.command).toEqual({
    id: "3812681",
    type: "reachGoal",
    goal: "citygoRegistrationCompleted",
    url: canonical,
    referrer: "",
    title: "CityGo",
  });
  expect(avito.map((row) => row.command.type)).toEqual([
    "pageView",
    "reachGoal",
  ]);
  expect(avito[1]?.command).toEqual({
    id: 3496456,
    type: "reachGoal",
    goalName: "citygo_registration_completed",
  });
  expect(JSON.stringify(state.commands)).not.toMatch(/PRIVATE|private-email/);
  expect(state.commands.every((row) => row.url === canonical)).toBe(true);
  expect(state.commands.every((row) => row.referrer === "")).toBe(true);
  expect(await page.evaluate(() => "_tmr" in window || "_apxl" in window)).toBe(
    false,
  );
  const count = state.commands.length;
  await page.locator("#parent-action").click();
  await page.evaluate(() =>
    history.pushState(null, "", "/private?phone=PRIVATE"),
  );
  await page.waitForTimeout(100);
  expect(state.commands).toHaveLength(count);
  expect(state.unexpected).toEqual([]);
  await page.waitForLoadState("networkidle");
});

test("removing the paid frame destroys its SDK timers without changing the parent", async ({
  page,
}) => {
  const { state } = await harness(page, { heartbeat: true });
  await attach(page);
  await post(page, init());
  await ready(page);
  await expect
    .poll(
      () =>
        state.commands.filter((row) => row.command.type === "childHeartbeat")
          .length,
    )
    .toBeGreaterThan(1);
  await page.locator("#pixel-test-frame").evaluate((node) => node.remove());
  await page.waitForTimeout(100);
  const count = state.commands.length;
  await page.locator("#parent-action").click();
  await page.evaluate(() =>
    history.replaceState(null, "", "/private?phone=PRIVATE"),
  );
  await page.waitForTimeout(350);
  expect(state.commands).toHaveLength(count);
  expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => "_tmr" in window || "_apxl" in window)).toBe(
    false,
  );
});

test("a removed frame cannot be revived by a delayed SDK response", async ({
  page,
}) => {
  const { state, releaseSdk } = await harness(page, { delaySdk: true });
  await attach(page);
  await post(page, init());
  await expect.poll(() => state.sdk.length).toBe(2);
  await page.locator("#pixel-test-frame").evaluate((node) => node.remove());
  releaseSdk();
  await page.waitForTimeout(100);
  await page.locator("#parent-action").click();
  expect(state.commands).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => "_tmr" in window || "_apxl" in window)).toBe(
    false,
  );
  await page.waitForLoadState("networkidle");
});

test("one blocked provider does not create a top-document fallback or duplicate the remaining provider", async ({
  page,
}) => {
  const { state } = await harness(page, { failVk: true });
  await attach(page);
  await post(page, init());
  await ready(page);
  await post(page, registration());
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands.every((row) => row.provider === "avito")).toBe(true);
  expect(state.commands.map((row) => row.command.type)).toEqual([
    "pageView",
    "reachGoal",
  ]);
  expect(state.sdk).toHaveLength(2);
  expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => "_tmr" in window || "_apxl" in window)).toBe(
    false,
  );
  await page.waitForLoadState("networkidle");
});

test("opening the public frame as a top document does not start an advertising counter", async ({
  page,
}) => {
  const { state } = await harness(page);
  await page.goto(analyticsOrigin + "/paid-pixels/frame.html");
  await page.evaluate(
    (message) => postMessage(message, location.origin),
    init(),
  );
  await page.waitForLoadState("networkidle");
  expect(state.sdk).toEqual([]);
  expect(state.commands).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
