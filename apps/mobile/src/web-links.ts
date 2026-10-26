export const defaultMobileWebUrl = "https://app.xn--c1ajazlh.xn--p1ai";

/** Web documents are served by Web, including when native uses a direct API. */
export function mobileWebDestination(webUrl: string, path: string): string {
  const web = new URL(webUrl);
  if (
    !["https:", "http:"].includes(web.protocol) ||
    web.username ||
    web.password ||
    web.search ||
    web.hash ||
    web.pathname !== "/" ||
    !["", "/legal/personal-data-consent", "/legal/marketing-consent"].includes(
      path,
    )
  )
    throw new Error("Invalid CityGo Web destination");
  return new URL(path || "/", web.origin).href;
}
