"use client";

import { maxLaunch } from "./max-launch";
import { MiniAppEntry } from "./mini-app-entry";

export function MaxEntry() {
  return <MiniAppEntry host={maxLaunch} />;
}
