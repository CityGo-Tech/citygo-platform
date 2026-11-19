import type { Viewport } from "next";
import type { ReactNode } from "react";

export const viewport: Viewport = {
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function MiniAppLayout({ children }: { children: ReactNode }) {
  return children;
}
