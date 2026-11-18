"use client";

import { MiniAppEntry } from "./mini-app-entry";
import { telegramLaunch } from "./telegram-launch";

export function TelegramEntry() {
  return <MiniAppEntry host={telegramLaunch} />;
}
