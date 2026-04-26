export interface SeamScope {
  kind: string;
  id: string;
}

export interface SeamRecord<T = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  data: T;
  scopeKind: string;
  scopeId: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deletedAt?: string;
}

export type SeamErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "TYPE_MISMATCH"
  | "VERSION_CONFLICT"
  | "INVALID"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CURSOR_EXPIRED";

export class SeamError extends Error {
  readonly code: SeamErrorCode;

  constructor(code: SeamErrorCode, message: string = code) {
    super(message);
    this.name = "SeamError";
    this.code = code;
  }
}
