import type { MiniAppBridge, MiniAppHost } from "./host";

type MaxWebApp = {
  initDataUnsafe?: { start_param?: unknown };
  openLink?: (url: string) => void;
  BackButton?: {
    show?: () => void;
    hide?: () => void;
    onClick?: (listener: () => void) => void;
    offClick?: (listener: () => void) => void;
  };
};

export const maxLaunch: MiniAppHost = {
  name: "MAX",
  script: "https://st.max.ru/js/max-web-app.js",
  launchFragmentKey: "WebAppData",
  connect() {
    const sdk = (window as Window & { WebApp?: MaxWebApp }).WebApp;
    const openLink = sdk?.openLink;
    if (typeof openLink !== "function") return undefined;

    const startParam = sdk?.initDataUnsafe?.start_param;
    const bridge: MiniAppBridge = {
      initialTask: typeof startParam === "string" ? startParam : undefined,
      openExternal: (url) => openLink.call(sdk, url),
    };

    const back = sdk?.BackButton;
    const show = back?.show;
    const hide = back?.hide;
    const onClick = back?.onClick;
    const offClick = back?.offClick;
    if (
      typeof show === "function" &&
      typeof hide === "function" &&
      typeof onClick === "function" &&
      typeof offClick === "function"
    ) {
      bridge.onBack = (listener) => {
        onClick.call(back, listener);
        show.call(back);
        return () => {
          offClick.call(back, listener);
          hide.call(back);
        };
      };
    }
    return bridge;
  },
};
