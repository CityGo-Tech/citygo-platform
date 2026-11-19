import {
  nativeBackButton,
  type MiniAppBridge,
  type MiniAppHost,
  type NativeBackButton,
} from "./host";

type TelegramWebApp = {
  initData?: unknown;
  initDataUnsafe?: { start_param?: unknown };
  ready?: () => void;
  openLink?: (url: string) => void;
  close?: () => void;
  BackButton?: NativeBackButton;
};

function connect(): MiniAppBridge | undefined {
  const app = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } })
    .Telegram?.WebApp;
  if (!app || typeof app.openLink !== "function") return;

  const task = app.initDataUnsafe?.start_param;
  return {
    initialTask: typeof task === "string" ? task : undefined,
    initData: typeof app.initData === "string" ? app.initData : undefined,
    openExternal: (url) => app.openLink?.(url),
    ready: typeof app.ready === "function" ? () => app.ready?.() : undefined,
    close: typeof app.close === "function" ? () => app.close?.() : undefined,
    onBack: nativeBackButton(app.BackButton),
  };
}

export const telegramLaunch: MiniAppHost = {
  name: "Telegram",
  provider: "telegram",
  script: "https://telegram.org/js/telegram-web-app.js?65",
  launchFragmentKey: "tgWebAppData",
  connect,
};
