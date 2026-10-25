import type { ServiceConsentChoice } from "@citygo/contracts";

/** Pending proofs and the original choices belong only to this memory lifetime. */
export type PendingEmailRegistration = {
  email: string;
  challengeId: string;
  proof: string;
  expiresAt: string;
  resendAt: number;
  consents: ServiceConsentChoice;
};

export function registrationClock(
  pending: Pick<PendingEmailRegistration, "expiresAt" | "resendAt">,
  now: number,
) {
  const expiresAt = Date.parse(pending.expiresAt);
  return {
    expired: !Number.isFinite(expiresAt) || now >= expiresAt,
    resendSeconds: Math.max(0, Math.ceil((pending.resendAt - now) / 1000)),
  };
}

export function pendingEmailRegistration(
  email: string,
  challenge: {
    challengeId: string;
    proof: string;
    expiresAt: string;
    resendAfterSeconds: number;
  },
  now: number,
  consents: ServiceConsentChoice,
): PendingEmailRegistration {
  return {
    email,
    challengeId: challenge.challengeId,
    proof: challenge.proof,
    expiresAt: challenge.expiresAt,
    resendAt: now + challenge.resendAfterSeconds * 1000,
    consents: { ...consents },
  };
}

export function isEmailRegistrationCode(code: string) {
  return /^\d{6}$/.test(code);
}
