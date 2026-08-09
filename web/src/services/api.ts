import { API_URL } from '@/config/urls';

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

export interface HttpResponse<T> {
  data: T;
  status: number;
}

export async function httpJsonWithStatus<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown },
): Promise<HttpResponse<T>> {
  const url = API_URL + path;
  const hasBody = init?.body !== undefined;

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new ApiError(
      'unreachable',
      `could not reach the scheduler API at ${url}: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }

  if (res.status === 204) return { data: undefined as T, status: res.status };

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // internal/api/errors.go writes {message, code, fields?} on every non-2xx.
    throw new ApiError(
      (body?.code as string) ?? 'unknown',
      (body?.message as string) ?? `request failed with ${res.status}`,
      res.status,
      body?.fields,
    );
  }
  return { data: body as T, status: res.status };
}

export async function httpJson<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown },
): Promise<T> {
  const { data } = await httpJsonWithStatus<T>(path, init);
  return data;
}
