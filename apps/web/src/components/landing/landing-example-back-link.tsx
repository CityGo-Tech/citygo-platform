import Link from "next/link";
import type { ReactNode } from "react";

export function LandingExampleBackLink({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href="/landing/v8" className={className} referrerPolicy="origin">
      {children}
    </Link>
  );
}
