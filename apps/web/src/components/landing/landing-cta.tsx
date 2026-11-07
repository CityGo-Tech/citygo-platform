"use client";
import { useEffect, useState, type ReactNode } from "react";
import {
  browserAcquisitionAllowed,
  captureLandingAttribution,
  landingStartHref,
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
  useEffect(() => {
    captureLandingAttribution(variant);
    if (browserAcquisitionAllowed())
      setHref(landingStartHref(productOrigin, variant, intent));
  }, [variant, intent]);
  return (
    <a
      href={href}
      className={className}
      referrerPolicy="origin"
      data-landing-cta={placement}
      data-landing-variant={variant}
      data-secondary={secondary || undefined}
      onClick={(event) => {
        event.currentTarget.href = browserAcquisitionAllowed()
          ? landingStartHref(productOrigin, variant, intent)
          : untrackedHref;
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
