import { expect, test } from "@playwright/test";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("CityGo icons are declared, served as images and decoded before login", async ({
  page,
}) => {
  await page.goto("/");
  const links = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        rel: element.getAttribute("rel"),
        href: (element as HTMLLinkElement).href,
      })),
    );
  const icon = (path: string, rel: string) => {
    const link = links.find(
      (entry) => new URL(entry.href).pathname === path && entry.rel === rel,
    );
    expect(link, "Missing icon metadata for " + path).toBeDefined();
    expect(new URL(link!.href).origin).toBe(new URL(page.url()).origin);
    return link!.href;
  };
  const icoUrl = icon("/favicon.ico", "icon");
  const icoResponse = await page.request.get(icoUrl);
  expect(icoResponse.status()).toBe(200);
  expect(icoResponse.headers()["content-type"]).toMatch(
    /^image\/(?:x-icon|vnd\.microsoft\.icon|ico)(?:;|$)/,
  );
  const ico = await icoResponse.body();
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(3);
  const dimensions = [];
  for (let index = 0; index < 3; index++) {
    const entry = 6 + index * 16;
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    expect(width).toBe(height);
    expect(offset).toBeGreaterThanOrEqual(54);
    expect(offset + bytes).toBeLessThanOrEqual(ico.length);
    expect(ico.subarray(offset, offset + 8)).toEqual(pngSignature);
    expect(ico.readUInt32BE(offset + 16)).toBe(width);
    expect(ico.readUInt32BE(offset + 20)).toBe(height);
    dimensions.push(width);
  }
  expect(dimensions).toEqual([16, 32, 48]);

  for (const [path, rel, size] of [
    ["/icon.png", "icon", 512],
    ["/apple-icon.png", "apple-touch-icon", 180],
  ] as const) {
    const url = icon(path, rel);
    const response = await page.request.get(url);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^image\/png(?:;|$)/);
    expect((await response.body()).subarray(0, 8)).toEqual(pngSignature);
    const decoded = await page.evaluate(async (href) => {
      const image = new Image();
      image.src = href;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, url);
    expect(decoded).toEqual({ width: size, height: size });
  }
});
