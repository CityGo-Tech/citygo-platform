import { NextRequest, NextResponse } from "next/server";
import {
  landingAttributionFromSearch,
  landingCookie,
  landingCookieMaxAge,
  landingIntentCookie,
} from "../../../components/landing/landing-attribution";

/** Cross-domain CTA arrives here before the query-free product/auth page. */
export function GET(request: NextRequest) {
  // A standalone Next server can expose its internal 0.0.0.0:3000 origin in
  // request.url. A fixed relative target works behind either public hostname
  // and cannot reflect Host/Forwarded or a caller-provided return URL.
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: "/" },
  });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  response.cookies.set(
    landingIntentCookie,
    request.nextUrl.searchParams.get("intent") === "login"
      ? "login"
      : "register",
    {
      path: "/",
      maxAge: 60,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    },
  );
  const versions = request.nextUrl.searchParams.getAll("landing");
  const version = versions.length === 1 ? versions[0] : null;
  if (
    (version === "v1" || version === "v8") &&
    request.headers.get("DNT") !== "1" &&
    request.headers.get("Sec-GPC") !== "1"
  ) {
    const attribution = landingAttributionFromSearch(
      version,
      request.nextUrl.searchParams,
    );
    // A non-auth cookie: readable by the registration client, never authorizes
    // access or affects pricing. Last CTA wins until registration begins.
    response.cookies.set(landingCookie, JSON.stringify(attribution), {
      path: "/",
      maxAge: landingCookieMaxAge,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    });
  } else if (
    request.headers.get("DNT") === "1" ||
    request.headers.get("Sec-GPC") === "1"
  ) {
    response.cookies.set(landingCookie, "", {
      path: "/",
      maxAge: 0,
      sameSite: "lax",
    });
  }
  return response;
}
