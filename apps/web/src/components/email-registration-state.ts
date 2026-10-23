/** Pending proofs belong only to the current in-memory registration lifetime. */
export type PendingEmailRegistration = {
  email: string;
  challengeId: string;
  proof: string;
  expiresAt: string;
  resendAt: number;
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
): PendingEmailRegistration {
  return {
    email,
    challengeId: challenge.challengeId,
    proof: challenge.proof,
    expiresAt: challenge.expiresAt,
    resendAt: now + challenge.resendAfterSeconds * 1000,
  };
}

export function isEmailRegistrationCode(code: string) {
  return /^\d{6}$/.test(code);
}
