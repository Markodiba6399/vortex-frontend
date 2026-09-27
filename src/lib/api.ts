import type {
  CreateIntentRequest,
  CreateIntentResponse,
  RegisterSolverRequest,
  RegisterSolverResponse,
  SubmitIntentResponse,
  SubmitRegistrationResponse,
} from "./types";
import {
  ValidationError,
  createIntentResponseSchema,
  submitIntentResponseSchema,
  registerSolverResponseSchema,
  submitRegistrationResponseSchema,
  type Validator,
} from "./schemas";

const TIMEOUT_MS = 10_000;
/** Error bodies beyond this many characters are truncated before use. */
export const MAX_ERROR_BODY = 2_000;
export const DEFAULT_RETRIES = 2;
const RETRY_BASE_MS = 300;

// Validate API_URL at module load time for supply-chain defense
function validateApiUrl(urlString: string): string {
  try {
    const url = new URL(urlString);

    // In production, require https:// for security
    if (process.env["NODE_ENV"] === "production" && url.protocol !== "https:") {
      throw new Error(
        `API_URL must use https:// in production. Got: ${url.protocol}//`
      );
    }

    // Allow http:// in development (localhost)
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(
        `API_URL must use http:// or https://. Got: ${url.protocol}//`
      );
    }

    return urlString;
  } catch (err) {
    if (err instanceof Error && err.message.includes("API_URL must")) {
      throw err;
    }
    throw new Error(
      `NEXT_PUBLIC_API_URL is not a valid URL: "${urlString}". Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const API_URL = validateApiUrl(process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000");

export class ApiError extends Error {
  status: number;
  /** Machine-readable code when the error body was JSON (`{code, message}`). */
  code: string | undefined;
  requestId: string | undefined;
  /** Parsed `Retry-After` in milliseconds, when present. */
  retryAfterMs: number | undefined;

  constructor(
    message: string,
    status: number,
    extra: { code?: string; requestId?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = extra.code;
    this.requestId = extra.requestId;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

export class TimeoutError extends Error {
  requestId: string | undefined;

  constructor(requestId?: string) {
    super("Request timed out. Please try again.");
    this.name = "TimeoutError";
    this.requestId = requestId;
  }
}

export type ApiFetchOptions<T> = {
  /** Caller cancellation; merged with the internal timeout. */
  signal?: AbortSignal | undefined;
  /**
   * Retry attempts on network error / timeout / 5xx. GETs default to
   * DEFAULT_RETRIES; POSTs retry only when an idempotency key is present.
   * Pass `false` to opt out.
   */
  retry?: number | false;
  /** Sent as `Idempotency-Key`; reused across retries of the same call. */
  idempotencyKey?: string;
  validator?: Validator<T> | ((val: unknown) => val is T);
};

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function toApiError(res: Response, requestId: string): Promise<ApiError> {
  const raw = (await res.text().catch(() => "")).slice(0, MAX_ERROR_BODY);
  let message = raw || res.statusText;
  let code: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (typeof p["message"] === "string") message = p["message"].slice(0, MAX_ERROR_BODY);
      if (typeof p["code"] === "string") code = p["code"];
    }
  } catch {
    // Non-JSON body: keep the truncated text. It is only ever rendered as text.
  }
  const retryAfterMs = parseRetryAfter(res.headers?.get?.("Retry-After") ?? null);
  return new ApiError(message, res.status, {
    requestId,
    ...(code !== undefined && { code }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  });
}

function isRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof ApiError) return err.status >= 500;
  // fetch() rejects with TypeError on network failure.
  return err instanceof TypeError;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError());
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function attempt<T>(
  path: string,
  init: RequestInit | undefined,
  headers: Record<string, string>,
  requestId: string,
  opts: ApiFetchOptions<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  // Manual signal merge (AbortSignal.any is not available everywhere).
  const onCallerAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });

    if (!res.ok) throw await toApiError(res, requestId);
    if (res.status === 204 || res.headers?.get?.("Content-Length") === "0") return undefined as T;

    const data: unknown = await res.json();

    const v = opts.validator;
    if (v) {
      try {
        const result = v(data);
        // Throwing validators return the value; guards return a boolean.
        if (result === false) throw new ValidationError(`Invalid response from ${path}`);
        if (typeof result !== "boolean") return result as T;
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new ValidationError(`Invalid response from ${path}: ${err.message}`, err.path);
        }
        throw err;
      }
    }
    return data as T;
  } catch (err) {
    if (isAbortError(err) || (err instanceof Error && err.name === "AbortError")) {
      // Caller aborts always surface as AbortError, never TimeoutError.
      if (!timedOut || opts.signal?.aborted) throw abortError();
      throw new TimeoutError(requestId);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  validatorOrOpts?: ApiFetchOptions<T>["validator"] | ApiFetchOptions<T>,
): Promise<T> {
  const opts: ApiFetchOptions<T> =
    typeof validatorOrOpts === "function" ? { validator: validatorOrOpts } : validatorOrOpts ?? {};
  const method = (init?.method ?? "GET").toUpperCase();
  const requestId = newId();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const canRetry = method === "GET" || method === "HEAD" || Boolean(opts.idempotencyKey);
  const maxRetries = !canRetry || opts.retry === false ? 0 : opts.retry ?? DEFAULT_RETRIES;

  for (let n = 0; ; n++) {
    try {
      return await attempt(path, init, headers, requestId, opts);
    } catch (err) {
      if (n >= maxRetries || !isRetryable(err)) throw err;
      await wait(RETRY_BASE_MS * 2 ** n, opts.signal);
    }
  }
}

// ── Client error taxonomy (consumed by AppSWRProvider / ErrorState) ─────────

export type ClientErrorKind = "network" | "timeout" | "http" | "validation";

export class ClientError extends Error {
  kind: ClientErrorKind;
  status: number | undefined;
  requestId: string | undefined;
  retryAfterMs: number | undefined;

  constructor(
    kind: ClientErrorKind,
    message: string,
    extra: { status?: number; requestId?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ClientError";
    this.kind = kind;
    this.status = extra.status;
    this.requestId = extra.requestId;
    this.retryAfterMs = extra.retryAfterMs;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/** i18n key for each error kind; ErrorState renders the localised message. */
export const CLIENT_ERROR_MESSAGE_KEYS: Record<ClientErrorKind, string> = {
  network: "error.network",
  timeout: "error.timeout",
  http: "error.http",
  validation: "error.validation",
};

export function toClientError(err: unknown): ClientError {
  if (err instanceof ClientError) return err;
  if (err instanceof TimeoutError) {
    return new ClientError("timeout", err.message, { cause: err, ...(err.requestId && { requestId: err.requestId }) });
  }
  if (err instanceof ApiError) {
    return new ClientError("http", err.message, {
      cause: err,
      status: err.status,
      ...(err.requestId && { requestId: err.requestId }),
      ...(err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }),
    });
  }
  if (err instanceof ValidationError) return new ClientError("validation", err.message, { cause: err });
  return new ClientError("network", err instanceof Error ? err.message : String(err), { cause: err });
}

/**
 * Typed SWR fetcher bound to a validator, so hooks cannot fetch unvalidated
 * data. Retries are left to SWR's global policy (AppSWRProvider).
 */
export function endpoint<T>(validator: Validator<T>) {
  return (path: string) => apiFetch<T>(path, undefined, { validator, retry: false });
}

export function createIntent(req: CreateIntentRequest, idempotencyKey: string = newId()) {
  return apiFetch<CreateIntentResponse>(
    "/intents",
    { method: "POST", body: JSON.stringify(req) },
    { validator: createIntentResponseSchema, idempotencyKey },
  );
}

export function submitIntent(intentId: string, signedXdr: string, idempotencyKey: string = newId()) {
  return apiFetch<SubmitIntentResponse>(
    `/intents/${intentId}/submit`,
    { method: "POST", body: JSON.stringify({ signedXdr }) },
    { validator: submitIntentResponseSchema, idempotencyKey },
  );
}

export function acceptIntent(intentId: string, solverAddress: string, idempotencyKey: string = newId()) {
  return apiFetch<SubmitIntentResponse>(
    `/intents/${intentId}/accept`,
    { method: "POST", body: JSON.stringify({ solverAddress }) },
    { validator: submitIntentResponseSchema, idempotencyKey },
  );
}

export function registerSolver(req: RegisterSolverRequest, idempotencyKey: string = newId()) {
  return apiFetch<RegisterSolverResponse>(
    "/solvers",
    { method: "POST", body: JSON.stringify(req) },
    { validator: registerSolverResponseSchema, idempotencyKey },
  );
}

export function submitSolverRegistration(
  registrationId: string,
  signedXdr: string,
  idempotencyKey: string = newId(),
) {
  return apiFetch<SubmitRegistrationResponse>(
    `/solvers/${registrationId}/submit`,
    { method: "POST", body: JSON.stringify({ signedXdr }) },
    { validator: submitRegistrationResponseSchema, idempotencyKey },
  );
}
