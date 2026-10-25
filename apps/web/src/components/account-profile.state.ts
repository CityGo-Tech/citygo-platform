import { ApiError, type createClient } from "@citygo/api-client";
import {
  emailRegistrationChallengeSchema,
  type AccountProfile,
} from "@citygo/contracts";

type Client = Pick<
  ReturnType<typeof createClient>,
  | "getAccountProfile"
  | "requestAccountEmailVerification"
  | "resendAccountEmailVerification"
  | "confirmAccountEmailVerification"
>;
export type AccountProfileState = {
  phase: "loading" | "ready" | "unavailable" | "closed";
  profile: AccountProfile | null;
  busy: "profile" | "request" | "resend" | "confirm" | null;
  challenge: { expiresAt: string; resendAt: number } | null;
  retryAt: number;
  error: string;
  notice: string;
};

export function isAccountEmailCode(code: string) {
  return /^[0-9]{6}$/.test(code);
}

/** A single account/view lifetime. Capabilities and codes never enter published
 * state, storage, URLs or diagnostics. No loading/refresh path sends a letter.
 */
export function createAccountProfileResource({
  userId,
  client,
  sessionSignal,
  publish,
  onAccessDenied,
  now = Date.now,
}: {
  userId: string;
  client: Client;
  sessionSignal: AbortSignal;
  publish: (state: AccountProfileState) => void;
  onAccessDenied: () => void;
  now?: () => number;
}) {
  const empty = (phase: AccountProfileState["phase"]): AccountProfileState => ({
    phase,
    profile: null,
    busy: null,
    challenge: null,
    retryAt: 0,
    error: "",
    notice: "",
  });
  let state = empty("loading"),
    disposed = false,
    generation = 0;
  let pending: { challengeId: string; proof: string } | null = null;
  const active = () =>
    !disposed && !sessionSignal.aborted && state.phase !== "closed";
  const current = (version: number) => active() && generation === version;
  function commit(next: AccountProfileState) {
    if (!active()) return;
    state = next;
    publish(next);
  }
  function close() {
    generation++;
    pending = null;
    state = empty("closed");
    if (!disposed) publish(state);
  }
  sessionSignal.addEventListener("abort", close, { once: true });
  function ownerMatches(id: string) {
    if (id === userId) return true;
    close();
    onAccessDenied();
    return false;
  }
  function failure(
    cause: unknown,
    operation: NonNullable<AccountProfileState["busy"]>,
  ) {
    if (!active()) return;
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
      close();
      onAccessDenied();
      return;
    }
    const status = cause instanceof ApiError ? cause.status : null;
    const error =
      status === 429
        ? "Слишком много попыток. Подождите и попробуйте позже."
        : operation === "profile"
          ? "Не удалось загрузить профиль. Попробуйте ещё раз."
          : operation === "confirm" && status === 400
            ? "Код не подошёл или срок его действия истёк. Проверьте код из последнего письма."
            : status === 409
              ? "Статус подтверждения изменился. Обновите профиль и попробуйте снова."
              : operation === "confirm"
                ? "Не удалось подтвердить email. Попробуйте ещё раз."
                : "Не удалось подтвердить отправку письма. Проверьте почту или попробуйте позже.";
    if (status === 409 || operation === "profile") pending = null;
    commit({
      ...state,
      phase: operation === "profile" ? "unavailable" : state.phase,
      busy: null,
      challenge:
        status === 409 || operation === "profile" ? null : state.challenge,
      error,
      notice: "",
    });
  }
  async function load() {
    if (!active() || state.busy) return;
    const version = ++generation;
    pending = null;
    commit({ ...empty("loading"), retryAt: state.retryAt, busy: "profile" });
    try {
      const profile = await client.getAccountProfile();
      if (!current(version) || !ownerMatches(profile.userId)) return;
      commit({ ...empty("ready"), profile, retryAt: state.retryAt });
    } catch (cause) {
      if (current(version)) failure(cause, "profile");
    }
  }
  async function send(resend: boolean) {
    const profile = state.profile;
    if (
      !active() ||
      state.busy ||
      state.phase !== "ready" ||
      !profile?.email ||
      profile.emailVerified ||
      profile.emailConfirmation !== "available" ||
      now() < state.retryAt
    )
      return;
    const expired =
      !!state.challenge && now() >= Date.parse(state.challenge.expiresAt);
    if (
      resend &&
      (!pending ||
        !state.challenge ||
        expired ||
        now() < state.challenge.resendAt)
    )
      return;
    if (!resend && pending && !expired) return;
    const capability = resend ? pending : null;
    if (!resend) pending = null;
    const version = ++generation;
    const operation = resend ? "resend" : "request";
    // An unknown delivery outcome must not immediately trigger another send.
    commit({
      ...state,
      busy: operation,
      error: "",
      notice: "",
      retryAt: now() + 60_000,
    });
    try {
      const challenge = emailRegistrationChallengeSchema.parse(
        await (capability
          ? client.resendAccountEmailVerification(capability)
          : client.requestAccountEmailVerification()),
      );
      if (!current(version)) return;
      pending = { challengeId: challenge.challengeId, proof: challenge.proof };
      const resendAt = now() + challenge.resendAfterSeconds * 1000;
      commit({
        ...state,
        busy: null,
        challenge: { expiresAt: challenge.expiresAt, resendAt },
        retryAt: Math.max(state.retryAt, resendAt),
        notice: "Введите код из письма.",
      });
    } catch (cause) {
      if (current(version)) failure(cause, operation);
    }
  }
  async function confirm(code: string) {
    if (
      !active() ||
      state.busy ||
      !pending ||
      !state.challenge ||
      !state.profile ||
      now() >= Date.parse(state.challenge.expiresAt) ||
      !isAccountEmailCode(code)
    )
      return;
    const capability = pending,
      version = ++generation;
    commit({ ...state, busy: "confirm", error: "", notice: "" });
    try {
      const receipt = await client.confirmAccountEmailVerification({
        ...capability,
        code,
      });
      if (!current(version) || !ownerMatches(receipt.userId)) return;
      if (receipt.emailVerified !== true)
        throw new Error("Invalid confirmation receipt");
      pending = null;
      commit({
        ...state,
        profile: { ...state.profile!, emailVerified: true },
        challenge: null,
        notice: "Email подтверждён.",
      });
      // Refresh the gift/status eligibility after confirmation; this is only a GET.
      try {
        const profile = await client.getAccountProfile();
        if (!current(version) || !ownerMatches(profile.userId)) return;
        if (!profile.emailVerified)
          throw new Error("Stale confirmation profile");
        commit({ ...state, profile, busy: null });
      } catch (cause) {
        if (!current(version)) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status))
          failure(cause, "profile");
        else
          commit({
            ...state,
            busy: null,
            error:
              "Email подтверждён. Не удалось обновить остальные данные профиля.",
          });
      }
    } catch (cause) {
      if (current(version)) failure(cause, "confirm");
    }
  }
  function cancelEmail() {
    if (!active()) return;
    generation++;
    pending = null;
    commit({ ...state, busy: null, challenge: null, error: "", notice: "" });
  }
  return {
    load,
    request: () => send(false),
    resend: () => send(true),
    confirm,
    cancelEmail,
    dispose() {
      disposed = true;
      generation++;
      pending = null;
      state = empty("closed");
      sessionSignal.removeEventListener("abort", close);
    },
  };
}
