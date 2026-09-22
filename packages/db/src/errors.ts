import { errorCodeForStatus, type ApiErrorCode } from "@citygo/contracts";

export class DomainError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: ApiErrorCode = errorCodeForStatus(statusCode),
    public currentVersion?: number,
  ) {
    super(message);
  }
}
