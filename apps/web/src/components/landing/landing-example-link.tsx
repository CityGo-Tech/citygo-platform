"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { captureLandingAttribution } from "./landing-attribution";
import type { LandingExampleKey } from "./landing-example-data";

export function LandingExampleLink({
  example,
  className,
  children,
}: {
  example: LandingExampleKey;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={`/landing/v8/examples/${example}`}
      className={className}
      referrerPolicy="origin"
      onClick={() => captureLandingAttribution("v8")}
    >
      {children}
    </Link>
  );
}
