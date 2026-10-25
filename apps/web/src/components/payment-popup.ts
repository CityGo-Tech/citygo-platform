import { topupOrderSchema } from "@citygo/contracts";

export type PaymentPopup = {
  opened: boolean;
  navigate(order: unknown): boolean;
  close(): void;
};

/** Called synchronously from an explicit create click, before any await. */
export function openPaymentPopup(
  browser: Pick<Window, "open"> = window,
): PaymentPopup {
  let popup: Window | null = null;
  let ownedBlank = true;
  const close = () => {
    if (!ownedBlank) return;
    ownedBlank = false;
    try {
      if (popup && !popup.closed && popup.location.href === "about:blank")
        popup.close();
    } catch {
      // A user-navigated or inaccessible tab no longer belongs to this flow.
    } finally {
      popup = null;
    }
  };
  try {
    // The noopener window feature returns null by design. Open only a blank
    // same-origin document, sever its opener synchronously, and retain the
    // handle solely to hand the already-created payment to this explicit click.
    // https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-open-dev
    popup = browser.open("about:blank", "_blank");
    if (!popup) return { opened: false, close, navigate: () => false };
    popup.opener = null;
    if (popup.opener !== null) throw new Error("Unsafe payment window");
    const document = popup.document;
    document.title = "Оплата CityGo";
    const policy = document.createElement("meta");
    policy.name = "referrer";
    policy.content = "no-referrer";
    document.head.append(policy);
    const heading = document.createElement("h1");
    heading.textContent = "Готовим страницу оплаты";
    const message = document.createElement("p");
    message.textContent = "Пожалуйста, подождите…";
    document.body.replaceChildren(heading, message);
  } catch {
    close();
    return { opened: false, close, navigate: () => false };
  }
  return {
    opened: true,
    close,
    navigate(order) {
      const parsed = topupOrderSchema.safeParse(order);
      if (
        !ownedBlank ||
        !parsed.success ||
        parsed.data.status !== "pending" ||
        !parsed.data.confirmationUrl
      ) {
        close();
        return false;
      }
      try {
        if (!popup || popup.closed) {
          close();
          return false;
        }
        if (popup.location.href !== "about:blank") {
          ownedBlank = false;
          popup = null;
          return false;
        }
        popup.location.replace(parsed.data.confirmationUrl);
        // From here the payment page belongs to the user, not component cleanup.
        ownedBlank = false;
        popup = null;
        return true;
      } catch {
        close();
        return false;
      }
    },
  };
}
