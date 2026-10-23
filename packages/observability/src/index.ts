export const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "password",
  "token",
  "apiKey",
  "req.body.password",
  "req.body.email",
  "req.body.code",
  "req.body.proof",
  "codeHash",
  "proofHash",
];
export function publicError(error: unknown): string {
  return error instanceof Error && error.name === "AbortError"
    ? "Запрос прерван"
    : "Не удалось выполнить запрос. Попробуйте ещё раз.";
}
