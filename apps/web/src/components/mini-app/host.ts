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

export function isMessengerLaunch(hash: string, key: string): boolean {
  return new URLSearchParams(hash.slice(1)).has(key);
}

export function cityGoEntryPath(task?: LandingTask): string {
  const search = new URLSearchParams({ intent: task ? "register" : "login" });
  if (task) search.set("task", task);
  return "/landing/start?" + search.toString();
}
