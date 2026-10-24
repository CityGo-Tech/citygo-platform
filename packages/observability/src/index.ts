export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "password",
  "newPassword",
  "currentPassword",
  "email",
  "code",
  "proof",
  "resetProof",
  "token",
  "apiKey",
  "req.body.password",
  "req.body.newPassword",
  "req.body.currentPassword",
  "req.body.email",
  "req.body.phone",
  "req.body.code",
  "req.body.proof",
  "req.body.resetProof",
  "codeHash",
  "proofHash",
  "resetProofHash",
  "passwordHash",
  "newPasswordHash",
  "req.body.codeHash",
  "req.body.proofHash",
  "req.body.resetProofHash",
  "req.body.passwordHash",
  "req.body.newPasswordHash",
];
export function publicError(error: unknown): string {
  return error instanceof Error && error.name === "AbortError"
    ? "Запрос прерван"
    : "Не удалось выполнить запрос. Попробуйте ещё раз.";
}
