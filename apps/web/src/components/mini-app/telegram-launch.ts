import type { MiniAppBridge, MiniAppHost } from "./host";

type TelegramWebApp = {
  initDataUnsafe?: { start_param?: string };
  ready?: () => void;
  openLink?: (url: string) => void;
  close?: () => void;
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (listener: () => void) => void;
    offClick: (listener: () => void) => void;
  };
};

function connect(): MiniAppBridge | undefined {
  const app = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } })
    .Telegram?.WebApp;
  if (!app || typeof app.openLink !== "function") return;

  const back = app.BackButton;
  return {
    initialTask: app.initDataUnsafe?.start_param,
    openExternal: (url) => app.openLink?.(url),
    ready: typeof app.ready === "function" ? () => app.ready?.() : undefined,
    close: typeof app.close === "function" ? () => app.close?.() : undefined,
    onBack:
      back &&
      typeof back.onClick === "function" &&
      typeof back.offClick === "function" &&
      typeof back.show === "function" &&
      typeof back.hide === "function"
        ? (listener) => {
            back.onClick(listener);
            back.show();
            return () => {
              back.offClick(listener);
              back.hide();
            };
          }
        : undefined,
  };
}

export const telegramLaunch: MiniAppHost = {
  name: "Telegram",
  script: "https://telegram.org/js/telegram-web-app.js?65",
  launchFragmentKey: "tgWebAppData",
  connect,
};
