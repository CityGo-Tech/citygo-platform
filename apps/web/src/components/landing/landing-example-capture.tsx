"use client";
import { useEffect } from "react";
import { captureLandingAttribution } from "./landing-attribution";

/** Preserve a bounded campaign through public examples; no recorder on examples. */
export function LandingExampleCapture() {
  useEffect(() => {
    captureLandingAttribution("v8");
    history.replaceState(history.state, "", location.pathname);
  }, []);
  return null;
}
