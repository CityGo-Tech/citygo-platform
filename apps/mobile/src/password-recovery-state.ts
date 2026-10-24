import type { createSessionGuard } from "@citygo/api-client";
import type { PasswordRecoveryChallenge } from "@citygo/contracts";
export type PendingPasswordRecovery = PasswordRecoveryChallenge & {
  resendAt: number;
};
export const recoveryNotice =
  "Если аккаунт с этой подтверждённой почтой существует, придёт письмо с кодом. Ответ не сообщает, зарегистрирован ли адрес.";
export function pendingPasswordRecovery(
  value: PasswordRecoveryChallenge,
  now: number,
): PendingPasswordRecovery {
  return {
    ...value,
    resendAt: now + Math.max(60, value.resendAfterSeconds) * 1000,
  };
}
export function recoveryClock(
  value: Pick<PendingPasswordRecovery, "expiresAt" | "resendAt">,
  now: number,
) {
  const expires = Date.parse(value.expiresAt);
  return {
    expired: !Number.isFinite(expires) || now >= expires,
    resendSeconds: Math.max(0, Math.ceil((value.resendAt - now) / 1000)),
  };
}
export function recoveryPasswordError(password: string, repeated: string) {
  if (password.length < 6 || password.length > 128)
    return "Пароль должен содержать от 6 до 128 любых символов.";
  if (password !== repeated) return "Пароли не совпадают.";
  return "";
}
export const recoveryCodeValid = (value: string) => /^[0-9]{6}$/.test(value);
/** The signal and gate are view-only, not a credential or SecureStore record. */
export function createPasswordRecoveryLifetime(
  parent: AbortSignal,
  createLifetime: typeof createSessionGuard,
) {
  const lifetime = createLifetime();
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
