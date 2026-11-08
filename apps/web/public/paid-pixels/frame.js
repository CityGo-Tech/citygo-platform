/* Approved provider scripts execute only inside this disposable empty document.
 * No user/contact/content/identity data or arbitrary URL enters its protocol.
 */
(() => {
  "use strict";
  if (window.parent === window) return;
  const origin = location.origin;
  let channel = null;
  let ready = false;
  let registrationSent = false;
  let config = null;
  const loaded = { vk: false, avito: false };
  function optedOut() {
    try {
      return (
        navigator.doNotTrack === "1" ||
        window.doNotTrack === "1" ||
        navigator.globalPrivacyControl === true ||
        localStorage.getItem("citygo.analytics.optout") === "1"
      );
    } catch {
      return true;
    }
  }
  function validId(value) {
    return (
      value === null ||
      (Number.isSafeInteger(value) && value > 0 && value < 10000000000)
    );
  }
  function allowedUrl(value) {
    try {
      if (typeof value !== "string" || value.length > 1024) return false;
      const url = new URL(value);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash ||
        !["/", "/landing/v1", "/landing/v8"].includes(url.pathname)
      )
        return false;
      const keys = new Set();
      for (const [key, value] of url.searchParams) {
        if (
          !["utm_source", "utm_medium", "utm_campaign", "utm_content"].includes(
            key,
          ) ||
          keys.has(key) ||
          !/^[a-z0-9][a-z0-9._-]{0,79}(?![\s\S])/.test(value)
        )
          return false;
        keys.add(key);
      }
      return true;
    } catch {
      return false;
    }
  }
  function script(src, provider) {
    return new Promise((resolve) => {
      const node = document.createElement("script");
      node.async = true;
      node.referrerPolicy = "no-referrer";
      node.src = src;
      const timeout = setTimeout(() => resolve(false), 10000);
      node.onload = () => {
        clearTimeout(timeout);
        loaded[provider] = true;
        resolve(true);
      };
      node.onerror = () => {
        clearTimeout(timeout);
        resolve(false);
      };
      document.head.append(node);
    });
  }
  window.addEventListener("message", (event) => {
    if (
      optedOut() ||
      event.source !== window.parent ||
      event.origin !== origin ||
      !event.data ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    )
      return;
    const value = event.data;
    if (value.type === "citygo-paid-init" && channel === null) {
      if (
        Object.keys(value).sort().join(",") !==
          "channel,config,type,url,version" ||
        value.version !== 1 ||
        typeof value.channel !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.channel) ||
        !allowedUrl(value.url) ||
        !value.config ||
        typeof value.config !== "object" ||
        Array.isArray(value.config) ||
        Object.keys(value.config).sort().join(",") !==
          "avitoCounterId,vkPixelId" ||
        !validId(value.config.vkPixelId) ||
        !validId(value.config.avitoCounterId) ||
        !(value.config.vkPixelId || value.config.avitoCounterId)
      )
        return;
      channel = value.channel;
      config = value.config;
      // This changes ONLY the empty child document's URL. Provider SDKs see
      // the approved public page and UTM labels, never the parent's raw URL.
      history.replaceState(null, "", value.url);
      const jobs = [];
      if (config.vkPixelId) {
        window._tmr = [
          {
            id: String(config.vkPixelId),
            type: "pageView",
            start: Date.now(),
            url: location.href,
            referrer: "",
            title: "CityGo",
          },
        ];
        jobs.push(script("https://top-fwz1.mail.ru/js/code.js", "vk"));
      }
      if (config.avitoCounterId) {
        window._apxl = [{ id: config.avitoCounterId, start: Date.now() }];
        window._apxl.q = [];
        window._apxl.sendEvent = (args) => {
          if (window._apxl.q.length < 10)
            window._apxl.q.push([args, location.href, Date.now()]);
        };
        jobs.push(script("https://ac.avito.ru/tag.js", "avito"));
      }
      void Promise.all(jobs).then((values) => {
        if (!values.some(Boolean)) return;
        ready = true;
        window.parent.postMessage(
          { type: "citygo-paid-ready", version: 1, channel },
          origin,
        );
      });
    } else if (
      value.type === "citygo-paid-registration" &&
      Object.keys(value).sort().join(",") === "channel,type,version" &&
      value.version === 1 &&
      channel !== null &&
      value.channel === channel &&
      ready &&
      !registrationSent
    ) {
      registrationSent = true;
      if (loaded.vk)
        window._tmr.push({
          id: String(config.vkPixelId),
          type: "reachGoal",
          goal: "citygoRegistrationCompleted",
          url: location.href,
          referrer: "",
          title: "CityGo",
        });
      if (loaded.avito)
        window._apxl.sendEvent({
          type: "reachGoal",
          goalName: "citygo_registration_completed",
        });
    }
  });
})();
