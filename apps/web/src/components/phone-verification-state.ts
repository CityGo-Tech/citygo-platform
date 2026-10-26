import { ApiError, type createClient } from "@citygo/api-client";
import {
  phoneVerificationChallengeSchema,
  phoneVerificationPolicySchema,
  phoneVerificationReceiptSchema,
  russianMobilePhoneSchema,
  type PhoneVerificationReceipt,
} from "@citygo/contracts";

type Client = Pick<
  ReturnType<typeof createClient>,
  | "phoneVerificationPolicy"
  | "beginPhoneVerification"
  | "resendPhoneVerification"
  | "confirmPhoneVerification"
>;
export type PhoneDeliveryProvider = "none" | "sms_ru" | "prosto_sms";
type Policy = Awaited<ReturnType<Client["phoneVerificationPolicy"]>>;
export type PhoneVerificationState = {
  phase:
    | "loading"
    | "ready"
    | "disabled"
    | "unavailable"
    | "email-required"
    | "already-granted"
    | "phone-bound"
    | "confirmed"
    | "closed";
  busy: boolean;
  deliveryProvider: PhoneDeliveryProvider;
  error: string;
  retryAt: number;
  challenge: {
    maskedPhone: string;
    expiresAt: string;
    resendAt: number;
  } | null;
  receipt: PhoneVerificationReceipt | null;
};

export function normalizePhone(raw: string) {
  const parsed = russianMobilePhoneSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function maskPhone(phone: string) {
  const canonical = normalizePhone(phone);
  return canonical
    ? `+7 ••• •••-${canonical.slice(-4, -2)}-${canonical.slice(-2)}`
    : "";
}
export function isPhoneCode(code: string) {
  return /^[0-9]{6}$/.test(code);
}
export function phoneDeliveryLabel(provider: PhoneDeliveryProvider) {
  return provider === "prosto_sms"
    ? "ProstoSMS"
    : provider === "sms_ru"
      ? "SMS.ru"
      : null;
}

/** Only this short-lived closure retains the capability and canonical number.
 * Never put a proof, phone or OTP in storage, a URL, diagnostics or markup.
 */
export function createPhoneVerificationResource({
  client,
  sessionSignal,
  publish,
  onAccessDenied,
  onGranted,
  now = Date.now,
}: {
  client: Client;
  sessionSignal: AbortSignal;
  publish: (state: PhoneVerificationState) => void;
  onAccessDenied?: () => void;
  onGranted?: () => void;
  now?: () => number;
}) {
  const empty = (
    phase: PhoneVerificationState["phase"],
    deliveryProvider: PhoneDeliveryProvider = "none",
  ): PhoneVerificationState => ({
    phase,
    deliveryProvider,
    busy: false,
    error: "",
    retryAt: 0,
    challenge: null,
    receipt: null,
  });
  let state = empty("loading");
  let disposed = false;
  let pending: {
    phone: string;
    challengeId: string;
    proof: string;
    deliveryProvider: PhoneDeliveryProvider;
  } | null = null;
  const active = () => !disposed && !sessionSignal.aborted;
  function commit(next: PhoneVerificationState) {
    if (!active()) return;
    state = next;
    publish(next);
  }
  function close() {
    pending = null;
    state = empty("closed");
    if (!disposed) publish(state);
  }
  sessionSignal.addEventListener("abort", close, { once: true });
  function failure(error: unknown, operation: "policy" | "send" | "confirm") {
    if (!active()) return;
    if (error instanceof ApiError && error.status === 401) {
      close();
      onAccessDenied?.();
      return;
    }
    // No raw server/provider error bodies or user input in UI diagnostics.
    const message =
      error instanceof ApiError && error.status === 429
        ? "Слишком много попыток. Подождите и попробуйте позже."
        : error instanceof ApiError && error.status === 409
          ? operation === "send"
            ? "Условия подтверждения изменились. Обновите статус и подтвердите согласие заново."
            : "Не удалось подтвердить подарок. Обновите статус или обратитесь в поддержку."
          : operation === "confirm" &&
              error instanceof ApiError &&
              error.status === 400
            ? "Код не подошёл или срок подтверждения истёк. Проверьте код из последней SMS."
            : operation === "send"
              ? "Не удалось подтвердить отправку. Подождите: код ещё может прийти."
              : "Не удалось подтвердить телефон. Попробуйте позже.";
    if (error instanceof ApiError && error.status === 409) {
      pending = null;
      commit({
        ...empty("unavailable", state.deliveryProvider),
        error: message,
      });
      return;
    }
    if (operation === "policy") {
      pending = null;
      commit({
        ...empty("unavailable"),
        retryAt: state.retryAt,
        error: message,
      });
      return;
    }
    commit({
      ...state,
      busy: false,
      phase: state.phase,
      error: message,
    });
  }
  function policyState(policy: Policy) {
    return empty(
      policy.phoneVerification !== "required"
        ? policy.phoneVerification
        : policy.giftStatus === "email_required"
          ? "email-required"
          : policy.giftStatus === "granted"
            ? "already-granted"
            : policy.giftStatus === "phone_bound"
              ? "phone-bound"
              : policy.giftStatus === "eligible"
                ? "ready"
                : "unavailable",
      policy.deliveryProvider,
    );
  }
  async function currentPolicyMatches(provider: PhoneDeliveryProvider) {
    let policy: Policy;
    try {
      policy = phoneVerificationPolicySchema.parse(
        await client.phoneVerificationPolicy(),
      );
    } catch (error) {
      failure(error, "policy");
      return false;
    }
    if (!active()) return false;
    const next = policyState(policy);
    if (
      provider !== "none" &&
      next.deliveryProvider === provider &&
      next.phase === "ready"
    )
      return true;
    pending = null;
    commit({
      ...next,
      error:
        next.phase === "phone-bound"
          ? ""
          : next.deliveryProvider !== provider
            ? "Условия подтверждения изменились. Проверьте их и подтвердите согласие заново."
            : "Условия подтверждения изменились. Проверьте текущий статус подарка.",
    });
    return false;
  }
  async function load() {
    if (!active() || state.busy) return;
    const previous = state;
    commit({ ...state, busy: true, error: "" });
    try {
      const policy = phoneVerificationPolicySchema.parse(
        await client.phoneVerificationPolicy(),
      );
      if (!active()) return;
      const next = policyState(policy);
      if (
        pending &&
        next.phase === "ready" &&
        pending.deliveryProvider === next.deliveryProvider
      )
        commit({ ...previous, busy: false, error: "" });
      else {
        pending = null;
        commit(next);
      }
    } catch (error) {
      pending = null;
      failure(error, "policy");
    }
  }
  async function send(raw?: string, consent = false) {
    if (!active() || state.phase !== "ready" || state.busy) return;
    if (
      now() < state.retryAt ||
      (state.challenge && now() < state.challenge.resendAt)
    )
      return;
    if (!consent) {
      commit({
        ...state,
        error: "Подтвердите согласие на получение кода по SMS.",
      });
      return;
    }
    const phone = pending?.phone ?? normalizePhone(raw ?? "");
    if (!phone) {
      commit({
        ...state,
        error: "Укажите российский мобильный номер +7 9XX XXX-XX-XX.",
      });
      return;
    }
    if (state.challenge && now() >= Date.parse(state.challenge.expiresAt))
      return;
    const current = pending;
    const deliveryProvider = state.deliveryProvider;
    if (deliveryProvider === "none") return;
    // Also throttle unknown outcomes locally. Never automatically retry a send.
    commit({ ...state, busy: true, error: "", retryAt: now() + 60_000 });
    try {
      // A stale consent must never route a number or capability to a newly
      // selected provider. This read is not an SMS or an automatic retry.
      if (!(await currentPolicyMatches(deliveryProvider))) return;
      if (state.challenge && now() >= Date.parse(state.challenge.expiresAt)) {
        commit({ ...state, busy: false });
        return;
      }
      const challenge = phoneVerificationChallengeSchema.parse(
        await (current
          ? client.resendPhoneVerification(
              current.challengeId,
              current.proof,
              phone,
              deliveryProvider,
            )
          : client.beginPhoneVerification(phone, deliveryProvider)),
      );
      if (!active()) return;
      if (
        current &&
        (challenge.challengeId !== current.challengeId ||
          challenge.proof !== current.proof)
      )
        throw new Error("Challenge identity mismatch");
      pending = {
        phone,
        challengeId: challenge.challengeId,
        proof: challenge.proof,
        deliveryProvider,
      };
      const resendAt = now() + challenge.resendAfterSeconds * 1000;
      commit({
        ...empty("ready", deliveryProvider),
        retryAt: resendAt,
        challenge: {
          maskedPhone: maskPhone(phone),
          expiresAt: challenge.expiresAt,
          resendAt,
        },
      });
    } catch (error) {
      failure(error, "send");
    }
  }
  async function confirm(code: string) {
    if (
      !active() ||
      state.busy ||
      state.phase !== "ready" ||
      !pending ||
      !state.challenge ||
      !isPhoneCode(code) ||
      now() >= Date.parse(state.challenge.expiresAt)
    )
      return;
    const current = pending;
    commit({ ...state, busy: true, error: "" });
    try {
      if (!(await currentPolicyMatches(current.deliveryProvider))) return;
      if (!state.challenge || now() >= Date.parse(state.challenge.expiresAt)) {
        commit({ ...state, busy: false });
        return;
      }
      const receipt = phoneVerificationReceiptSchema.parse(
        await client.confirmPhoneVerification(
          current.challengeId,
          current.proof,
          current.phone,
          code,
        ),
      );
      if (!active()) return;
      pending = null;
      commit({ ...empty("confirmed", current.deliveryProvider), receipt });
      // Refreshing the cabinet is independent of the committed gift receipt.
      // A presentation callback cannot turn a confirmed grant into a failure.
      try {
        onGranted?.();
      } catch {
        /* Keep the server-confirmed receipt. */
      }
    } catch (error) {
      failure(error, "confirm");
    }
  }
  return {
    load,
    start: (phone: string, consent: boolean) => send(phone, consent),
    resend: (consent: boolean) => send(undefined, consent),
    confirm,
    reset() {
      if (!active() || state.busy || state.phase !== "ready") return;
      pending = null;
      commit({
        ...empty("ready", state.deliveryProvider),
        retryAt: state.retryAt,
      });
    },
    dispose() {
      pending = null;
      disposed = true;
      sessionSignal.removeEventListener("abort", close);
    },
  };
}
