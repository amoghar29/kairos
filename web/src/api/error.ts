export class ApiError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;

  constructor(code: string, message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }

  // "validation_failed · 422" — the label the design puts above every error panel.
  get label(): string {
    return `${this.code} · ${this.status}`;
  }
}

export function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new ApiError('unreachable', message, 0);
}
