import {
  nativeBackButton,
  type MiniAppHost,
  type NativeBackButton,
} from "./host";

type MaxWebApp = {
  initData?: unknown;
  initDataUnsafe?: { start_param?: unknown };
  openLink?: (url: string) => void;
  BackButton?: NativeBackButton;
};

export const maxLaunch: MiniAppHost = {
  name: "MAX",
  provider: "max",
  script: "https://st.max.ru/js/max-web-app.js",
  launchFragmentKey: "WebAppData",
  connect() {
    const sdk = (window as Window & { WebApp?: MaxWebApp }).WebApp;
    const openLink = sdk?.openLink;
    if (typeof openLink !== "function") return undefined;

    const startParam = sdk?.initDataUnsafe?.start_param;
    return {
      initialTask: typeof startParam === "string" ? startParam : undefined,
      initData: typeof sdk?.initData === "string" ? sdk.initData : undefined,
      openExternal: (url) => openLink.call(sdk, url),
      onBack: nativeBackButton(sdk?.BackButton),
    };
  },
};
