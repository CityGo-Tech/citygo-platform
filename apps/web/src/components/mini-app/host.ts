import type { LandingTask } from "../landing/landing-task";

export type MiniAppBridge = {
  initialTask?: string;
  openExternal: (url: string) => void;
  onBack?: (listener: () => void) => () => void;
  close?: () => void;
  ready?: () => void;
};

export type MiniAppHost = {
  name: string;
  script: string;
  launchFragmentKey: string;
  connect: () => MiniAppBridge | undefined;
};

export type MiniAppLaunch = "browser" | "messenger" | "invalid";

export function miniAppLaunch(hash: string, key: string): MiniAppLaunch {
  const values = new URLSearchParams(hash.slice(1)).getAll(key);
  if (values.length === 0) return "browser";
  return values.length === 1 && values[0]?.trim() ? "messenger" : "invalid";
}

export type NativeBackButton = {
  show?: () => void;
  hide?: () => void;
  onClick?: (listener: () => void) => void;
  offClick?: (listener: () => void) => void;
};

export function nativeBackButton(
  button: NativeBackButton | undefined,
): MiniAppBridge["onBack"] {
  const { show, hide, onClick, offClick } = button ?? {};
  if (
    typeof show !== "function" ||
    typeof hide !== "function" ||
    typeof onClick !== "function" ||
    typeof offClick !== "function"
  )
    return;

  return (listener) => {
    let active = true;
    const handle = () => {
      if (active) listener();
    };
    const detach = () => {
      if (!active) return;
      active = false;
      try {
        offClick.call(button, handle);
      } catch {
        // Even if the SDK retains the callback, it no longer controls this screen.
      }
      try {
        hide.call(button);
      } catch {
        // The page still has its own back button.
      }
    };
    try {
      onClick.call(button, handle);
      show.call(button);
    } catch {
      detach();
    }
    return detach;
  };
}

export function cityGoEntryPath(task?: LandingTask): string {
  const search = new URLSearchParams({ intent: task ? "register" : "login" });
  if (task) search.set("task", task);
  return "/landing/start?" + search.toString();
}
