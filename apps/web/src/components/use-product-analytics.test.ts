import assert from "node:assert/strict";
import test from "node:test";
import {
  browserAnalyticsOptedOut,
  setBrowserAnalyticsOptOut,
} from "./use-product-analytics";

test("DNT, Global Privacy Control and unavailable storage stop optional analytics", (context) => {
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const store = new Map<string, string>();
  const browser = {
    doNotTrack: "0",
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    dispatchEvent: () => true,
  };
  const navigator = { doNotTrack: "0", globalPrivacyControl: false };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: browser,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigator,
  });
  context.after(() => {
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  assert.equal(browserAnalyticsOptedOut(), false);
  navigator.doNotTrack = "1";
  assert.equal(browserAnalyticsOptedOut(), true);
  navigator.doNotTrack = "0";
  navigator.globalPrivacyControl = true;
  assert.equal(browserAnalyticsOptedOut(), true);
  navigator.globalPrivacyControl = false;
  browser.doNotTrack = "1";
  assert.equal(browserAnalyticsOptedOut(), true);
  browser.doNotTrack = "0";
  setBrowserAnalyticsOptOut(true);
  assert.equal(browserAnalyticsOptedOut(), true);
  setBrowserAnalyticsOptOut(false);
  assert.equal(browserAnalyticsOptedOut(), false);

  browser.localStorage.getItem = () => {
    throw new Error("storage denied");
  };
  browser.localStorage.setItem = () => {
    throw new Error("storage denied");
  };
  browser.localStorage.removeItem = () => {
    throw new Error("storage denied");
  };
  assert.equal(browserAnalyticsOptedOut(), true);
  assert.doesNotThrow(() => setBrowserAnalyticsOptOut(true));
  assert.doesNotThrow(() => setBrowserAnalyticsOptOut(false));
});
