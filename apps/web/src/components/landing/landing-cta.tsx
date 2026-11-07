"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  browserAcquisitionAllowed,
  captureLandingAttribution,
  landingStartHref,
  landingTouchExpiresAt,
  type LandingVersion,
} from "./landing-attribution";
import { productOrigin } from "./landing-config";
import { trackProductEvent } from "../product-analytics";

export function LandingCta({
  variant,
  placement,
  children,
  className,
  secondary,
  intent = "register",
}: {
  variant: LandingVersion;
  placement: string;
  children: ReactNode;
  className?: string;
  secondary?: boolean;
  intent?: "register" | "login";
}) {
  const untrackedHref =
    productOrigin + (intent === "login" ? "/landing/start?intent=login" : "/");
  const [href, setHref] = useState(untrackedHref);
  const currentHref = () =>
    browserAcquisitionAllowed()
      ? landingStartHref(productOrigin, variant, intent)
      : untrackedHref;
  useEffect(() => {
    captureLandingAttribution(variant);
    const refresh = () =>
      setHref(
        browserAcquisitionAllowed()
          ? landingStartHref(productOrigin, variant, intent)
          : untrackedHref,
      );
    refresh();
    const expiresAt = landingTouchExpiresAt(variant);
    const expiryTimer =
      expiresAt === undefined
        ? undefined
        : window.setTimeout(refresh, Math.max(0, expiresAt - Date.now()) + 5);
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("citygo:analytics-preference", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("citygo:analytics-preference", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [variant, intent, untrackedHref]);
  return (
    <a
      href={href}
      className={className}
      referrerPolicy="origin"
      data-landing-cta={placement}
      data-landing-variant={variant}
      data-secondary={secondary || undefined}
      onPointerDown={(event) => {
        event.currentTarget.href = currentHref();
      }}
      onFocus={(event) => {
        event.currentTarget.href = currentHref();
      }}
      onContextMenu={(event) => {
        event.currentTarget.href = currentHref();
      }}
      onAuxClick={(event) => {
        event.currentTarget.href = currentHref();
      }}
      onClick={(event) => {
        event.currentTarget.href = currentHref();
        trackProductEvent("landing_cta_clicked", {
          surface: "landing",
          landingVersion: variant,
        });
      }}
    >
      {children}
    </a>
  );
}
