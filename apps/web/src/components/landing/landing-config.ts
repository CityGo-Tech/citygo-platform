/** Marketing links deliberately use the current product, not the legacy app. */
export const productOrigin = "https://pilot.xn--c1ajazlh.xn--p1ai";

export function productLegalHref(path = "/legal"): string {
  return new URL(path, productOrigin).href;
}
