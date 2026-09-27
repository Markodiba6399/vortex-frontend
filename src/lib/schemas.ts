import type {
  Quote,
  FeedItem,
  IntentDetail,
  OpenIntent,
  Solver,
  CreateIntentResponse,
  SubmitIntentResponse,
  RegisterSolverResponse,
  SubmitRegistrationResponse,
} from "./types";
import { secureLogger } from "./secureLogging";

export class ValidationError extends Error {
  /** Dotted path of the first failing field, e.g. `$[3].createdAt`. */
  path: string;

  constructor(message: string, path = "$") {
    super(message);
    this.name = "ValidationError";
    this.path = path;
  }
}

// ── Validator combinators ──────────────────────────────────────────────────
// A Validator returns the (typed) value or throws ValidationError naming the
// first failing field. Unknown fields are allowed for forward compatibility.

export type Validator<T> = (val: unknown, path?: string) => T;
export type Infer<V> = V extends Validator<infer T> ? T : never;

function fail(path: string, expected: string): never {
  throw new ValidationError(`Expected ${expected} at ${path}`, path);
}

export const str: Validator<string> = (val, path = "$") =>
  typeof val === "string" ? val : fail(path, "string");

export const nonEmptyStr: Validator<string> = (val, path = "$") =>
  str(val, path).length > 0 ? (val as string) : fail(path, "non-empty string");

export const num: Validator<number> = (val, path = "$") =>
  typeof val === "number" && Number.isFinite(val) ? val : fail(path, "finite number");

const NUMERIC_RE = /^\d+(\.\d+)?$/;
/** Non-negative decimal amount encoded as a string (no exponent, no sign). */
export const numericStr: Validator<string> = (val, path = "$") =>
  NUMERIC_RE.test(str(val, path)) ? (val as string) : fail(path, "numeric string");

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
export const isoDate: Validator<string> = (val, path = "$") => {
  const s = str(val, path);
  return ISO_RE.test(s) && !Number.isNaN(Date.parse(s)) ? s : fail(path, "ISO-8601 date");
};

const STRKEY_RE = /^[GC][A-Z2-7]{55}$/;
/** Stellar account (G…) or contract (C…) strkey. */
export const strkey: Validator<string> = (val, path = "$") =>
  STRKEY_RE.test(str(val, path)) ? (val as string) : fail(path, "Stellar strkey");

export function oneOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return (val, path = "$") =>
    typeof val === "string" && (values as readonly string[]).includes(val)
      ? (val as T[number])
      : fail(path, `one of ${values.join("|")}`);
}

export function optional<T>(v: Validator<T>): Validator<T | undefined> {
  return (val, path = "$") => (val === undefined ? undefined : v(val, path));
}

type Shape = Record<string, Validator<unknown>>;
type ObjectOf<S extends Shape> = {
  [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]>;
} & {
  [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Exclude<Infer<S[K]>, undefined>;
};

export function object<S extends Shape>(shape: S): Validator<ObjectOf<S>> {
  return (val, path = "$") => {
    if (typeof val !== "object" || val === null || Array.isArray(val)) fail(path, "object");
    // Unknown fields pass through; validated fields take the validator's output
    // (e.g. lists with invalid items dropped).
    const out: Record<string, unknown> = { ...(val as Record<string, unknown>) };
    for (const key of Object.keys(shape)) {
      const v = shape[key]!(out[key], `${path}.${key}`);
      if (v !== undefined) out[key] = v;
    }
    return out as ObjectOf<S>;
  };
}

/** Every element must validate; the first failure throws. */
export function arrayOf<T>(item: Validator<T>): Validator<T[]> {
  return (val, path = "$") => {
    if (!Array.isArray(val)) fail(path, "array");
    val.forEach((el, i) => item(el, `${path}[${i}]`));
    return val as T[];
  };
}

let strictLists = false;
/** Strict mode makes `listOf` throw on invalid items instead of dropping them (tests). */
export function setStrictValidation(strict: boolean) {
  strictLists = strict;
}

/**
 * Lenient list: the container must be an array, but invalid items are dropped
 * with a redacted warning so one bad row doesn't blank the whole view.
 */
export function listOf<T>(item: Validator<T>): Validator<T[]> {
  return (val, path = "$") => {
    if (!Array.isArray(val)) fail(path, "array");
    const out: T[] = [];
    val.forEach((el, i) => {
      try {
        out.push(item(el, `${path}[${i}]`));
      } catch (err) {
        if (strictLists || !(err instanceof ValidationError)) throw err;
        secureLogger.warn("Dropped invalid list item", { path: err.path });
      }
    });
    return out;
  };
}

/** Adapts a throwing validator into a boolean type guard. */
export function guard<T>(v: Validator<T>): (val: unknown) => val is T {
  return (val): val is T => {
    try {
      v(val);
      return true;
    } catch {
      return false;
    }
  };
}

// ── Endpoint schemas ───────────────────────────────────────────────────────

const intentStatus = oneOf(["pending", "accepted", "filled", "failed"] as const);

export const quoteSchema: Validator<Quote> = object({
  dstAmount: numericStr,
  solver: str,
  fillTimeSeconds: num,
  priceImpactPct: num,
  protocolFeePct: num,
  rate: str, // display string, e.g. "1 USDC = 8.46 XLM"
});

const feedItemShape = {
  id: nonEmptyStr,
  srcChain: nonEmptyStr,
  srcToken: nonEmptyStr,
  srcAmount: numericStr,
  dstToken: nonEmptyStr,
  solver: str,
  status: intentStatus,
  createdAt: isoDate,
  deadline: optional(isoDate),
};

export const feedItemSchema: Validator<FeedItem> = object(feedItemShape);
export const feedItemListSchema = listOf(feedItemSchema);

export const intentDetailSchema: Validator<IntentDetail> = object({
  ...feedItemShape,
  dstAmount: numericStr,
  minOut: numericStr,
  dstAddress: nonEmptyStr,
  deadline: isoDate,
  txHash: optional(str),
});

export const openIntentSchema: Validator<OpenIntent> = object({
  id: nonEmptyStr,
  srcChain: nonEmptyStr,
  srcToken: nonEmptyStr,
  srcAmount: numericStr,
  dstToken: nonEmptyStr,
  minOut: numericStr,
  deadline: isoDate,
});
export const openIntentListSchema = listOf(openIntentSchema);

export const solverSchema: Validator<Solver> = object({
  name: str,
  address: strkey,
  bondUsd: num,
  fills: num,
  failed: num,
  volumeUsd: num,
  avgFillTimeSeconds: num,
  successRatePct: num,
  chains: arrayOf(str),
  status: oneOf(["active", "inactive"] as const),
});
export const solverListSchema = listOf(solverSchema);

export const createIntentResponseSchema: Validator<CreateIntentResponse> = object({
  intentId: nonEmptyStr,
  unsignedXdr: nonEmptyStr,
});

export const submitIntentResponseSchema: Validator<SubmitIntentResponse> = object({
  intentId: nonEmptyStr,
  status: intentStatus,
});

export const registerSolverResponseSchema: Validator<RegisterSolverResponse> = object({
  registrationId: nonEmptyStr,
  unsignedXdr: nonEmptyStr,
});

export const submitRegistrationResponseSchema: Validator<SubmitRegistrationResponse> = object({
  registrationId: nonEmptyStr,
  status: oneOf(["active", "pending"] as const),
});

// Boolean guards kept for existing callers.
export const isQuote = guard(quoteSchema);
export const isFeedItem = guard(feedItemSchema);
export const isFeedItemArray = guard(arrayOf(feedItemSchema));
export const isIntentDetail = guard(intentDetailSchema);
export const isOpenIntent = guard(openIntentSchema);
export const isSolver = guard(solverSchema);
export const isSolverArray = guard(arrayOf(solverSchema));
export const isCreateIntentResponse = guard(createIntentResponseSchema);
export const isSubmitIntentResponse = guard(submitIntentResponseSchema);
export const isRegisterSolverResponse = guard(registerSolverResponseSchema);
export const isSubmitRegistrationResponse = guard(submitRegistrationResponseSchema);

// Paginated /intents response. A bare array (pre-pagination backend) is
// normalised into a single final page — compatibility shim, see
// docs/data-fetching.md for the removal plan.
export type IntentsPage = { items: FeedItem[]; nextCursor: string | null };
export const intentsPageSchema: Validator<IntentsPage> = (val, path = "$") => {
  if (Array.isArray(val)) return { items: feedItemListSchema(val, path), nextCursor: null };
  const { items, nextCursor } = object({
    items: feedItemListSchema,
    nextCursor: (v: unknown, p?: string) => (v === null ? undefined : optional(str)(v, p)),
  })(val, path);
  return { items, nextCursor: nextCursor || null };
};
