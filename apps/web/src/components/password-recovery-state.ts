import { createSessionGuard } from "@citygo/api-client";
import type { PasswordRecoveryChallenge } from "@citygo/contracts";

/** Capabilities and secrets belong only to this mounted view, never storage. */
export type PendingPasswordRecovery = PasswordRecoveryChallenge & {
  resendAt: number;
};
export const recoveryNotice =
  "Если аккаунт с этой подтверждённой почтой существует, придёт письмо с кодом. Ответ не сообщает, зарегистрирован ли адрес.";
export function pendingPasswordRecovery(
  challenge: PasswordRecoveryChallenge,
  now: number,
): PendingPasswordRecovery {
  return {
    ...challenge,
    resendAt: now + Math.max(60, challenge.resendAfterSeconds) * 1000,
  };
}
export function recoveryClock(
  pending: Pick<PendingPasswordRecovery, "expiresAt" | "resendAt">,
  now: number,
) {
  const expires = Date.parse(pending.expiresAt);
  return {
    expired: !Number.isFinite(expires) || now >= expires,
    resendSeconds: Math.max(0, Math.ceil((pending.resendAt - now) / 1000)),
  };
}
export function recoveryPasswordError(password: string, repeated: string) {
  if (password.length < 6 || password.length > 128)
    return "Пароль должен содержать от 6 до 128 любых символов.";
  if (password !== repeated) return "Пароли не совпадают.";
  return "";
}
export function recoveryCodeValid(code: string) {
  return /^[0-9]{6}$/.test(code);
}

/** Synchronous exclusion plus abort/generation checks also reject late replies. */
export function createPasswordRecoveryLifetime(parent: AbortSignal) {
  const lifetime = createSessionGuard();
  let locked = false;
  const reset = () => {
    lifetime.reset();
    locked = false;
  };
  parent.addEventListener("abort", reset);
  return {
    begin() {
      if (locked || parent.aborted) return null;
      locked = true;
      const ticket = lifetime.capture();
      return {
        signal: ticket.signal,
        active: () => !parent.aborted && ticket.active(),
        check() {
          ticket.check();
          if (parent.aborted) throw new Error("Recovery view ended");
        },
        finish() {
          if (ticket.active() && !parent.aborted) locked = false;
        },
      };
    },
    reset,
    dispose() {
      parent.removeEventListener("abort", reset);
      reset();
    },
  };
}
