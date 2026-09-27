import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  ApiError,
  DEFAULT_RETRIES,
  endpoint,
  MAX_ERROR_BODY,
  parseRetryAfter,
  TimeoutError,
  toClientError,
} from "./api";
import { ValidationError, feedItemListSchema, feedItemSchema } from "./schemas";
import { feedItem, jsonResponse } from "@/test/fixtures/api";

// Note: API_URL validation happens at module load time.
// Unit tests verify the apiFetch function behavior; integration tests
// and CI will verify that misconfigured environment variables fail at startup.
describe("API URL validation", () => {
  it("validates URL structure via the URL constructor", () => {
    // Valid URLs
    expect(() => new URL("http://localhost:4000")).not.toThrow();
    expect(() => new URL("https://api.example.com")).not.toThrow();

    // Invalid URLs
    expect(() => new URL("not a url")).toThrow();
    expect(() => new URL("ftp://api.example.com")).not.toThrow(); // URL constructor accepts it
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves with parsed JSON on a successful response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hello: "world" }),
    });

    const result = await apiFetch<{ hello: string }>("/ping");

    expect(result).toEqual({ hello: "world" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/ping$/),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("returns undefined for a 204 No Content response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("should not be called");
      },
    });

    const result = await apiFetch<undefined>("/ack", { method: "POST" });

    expect(result).toBeUndefined();
  });

  it("throws an ApiError with the response status on a failed request", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "intent not found",
    });

    await expect(apiFetch("/intents/missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "intent not found",
    });
  });

  it("wraps failures in the exported ApiError class", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "",
    });

    await expect(apiFetch("/boom")).rejects.toBeInstanceOf(ApiError);
  });

  it("throws a TimeoutError when the request exceeds the timeout", async () => {
    vi.useFakeTimers();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }
        }),
    );

    const promise = apiFetch("/slow", undefined, { retry: false });
    vi.advanceTimersByTime(10_000);

    await expect(promise).rejects.toThrow(TimeoutError);
    vi.useRealTimers();
  });

  it("throws a distinct TimeoutError message rather than a generic network error", async () => {
    vi.useFakeTimers();
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }
        }),
    );

    const promise = apiFetch("/slow", undefined, { retry: false });
    vi.advanceTimersByTime(10_000);

    await expect(promise).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Request timed out. Please try again.",
    });
    vi.useRealTimers();
  });
});

describe("apiFetch hardening", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const mockFetch = () => fetch as ReturnType<typeof vi.fn>;
  const headersOf = (call: number) => mockFetch().mock.calls[call]![1].headers as Record<string, string>;

  it("sends X-Request-Id and exposes it on ApiError with parsed JSON code/message", async () => {
    mockFetch().mockResolvedValue(jsonResponse({ code: "E_BAD", message: "Bad input" }, 400));
    const err = await apiFetch("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "E_BAD", message: "Bad input", status: 400 });
    expect((err as ApiError).requestId).toBe(headersOf(0)["X-Request-Id"]);
  });

  it("caps non-JSON error bodies", async () => {
    mockFetch().mockResolvedValue(jsonResponse("<b>x</b>".repeat(1000), 400));
    const err = (await apiFetch("/x").catch((e: unknown) => e)) as ApiError;
    expect(err.message.length).toBeLessThanOrEqual(MAX_ERROR_BODY);
  });

  it.each([
    ["GET 5xx retries", undefined, {}, 503, 1 + DEFAULT_RETRIES],
    ["GET 4xx does not retry", undefined, {}, 404, 1],
    ["GET opt-out", undefined, { retry: false as const }, 503, 1],
    ["POST without key does not retry", { method: "POST" }, {}, 503, 1],
    ["POST with key retries", { method: "POST" }, { idempotencyKey: "k1" }, 503, 1 + DEFAULT_RETRIES],
  ])("%s", async (_name, init, opts, status, calls) => {
    vi.useFakeTimers();
    mockFetch().mockResolvedValue(jsonResponse({}, status));
    const p = apiFetch("/x", init, opts).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await p).toBeInstanceOf(ApiError);
    expect(mockFetch()).toHaveBeenCalledTimes(calls);
  });

  it("reuses the Idempotency-Key across retries", async () => {
    mockFetch().mockRejectedValueOnce(new TypeError("network")).mockResolvedValue(jsonResponse({ ok: 1 }));
    vi.useFakeTimers();
    const p = apiFetch("/x", { method: "POST" }, { idempotencyKey: "k1" });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(headersOf(0)["Idempotency-Key"]).toBe("k1");
    expect(headersOf(1)["Idempotency-Key"]).toBe("k1");
  });

  it("caller abort surfaces as AbortError, not TimeoutError", async () => {
    mockFetch().mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const controller = new AbortController();
    const p = apiFetch("/x", undefined, { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws ValidationError with path via a throwing validator", async () => {
    mockFetch().mockResolvedValue(jsonResponse({ ...feedItem, createdAt: "nope" }));
    await expect(apiFetch("/x", undefined, { validator: feedItemSchema })).rejects.toMatchObject({
      name: "ValidationError",
      path: "$.createdAt",
    });
  });

  it("endpoint() fetchers validate and drop invalid list items", async () => {
    mockFetch().mockResolvedValue(jsonResponse([feedItem, { id: 1 }]));
    await expect(endpoint(feedItemListSchema)("/intents")).resolves.toEqual([feedItem]);
  });
});

describe("toClientError / parseRetryAfter", () => {
  it("classifies errors", () => {
    expect(toClientError(new TimeoutError()).kind).toBe("timeout");
    expect(toClientError(new ApiError("x", 500)).kind).toBe("http");
    expect(toClientError(new ValidationError("x")).kind).toBe("validation");
    expect(toClientError(new TypeError("Failed to fetch")).kind).toBe("network");
  });

  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
