import { describe, expect, it } from "vitest";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
} from "./failover-matches.js";

describe("Z.ai vendor error codes (#48988)", () => {
  describe("error 1311 — model not included in subscription plan", () => {
    it("classifies Z.ai 1311 JSON body as billing", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1311 with spaces as billing", () => {
      const raw = '{"code": 1311, "message": "model not on plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1311 as rate_limit", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1311 as auth", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isAuthErrorMessage(raw)).toBe(false);
    });

    it("classifies long Z.ai 1311 payloads as billing", () => {
      const raw = JSON.stringify({
        code: 1311,
        message: "The model you requested is not available in your current plan",
        details: "x".repeat(700),
      });
      expect(raw.length).toBeGreaterThan(512);
      expect(isBillingErrorMessage(raw)).toBe(true);
    });
  });

  describe("error 1113 — wrong endpoint or invalid credentials", () => {
    it("classifies Z.ai 1113 JSON body as auth", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1113 with spaces as auth", () => {
      const raw = '{"code": 1113, "message": "invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1113 as rate_limit", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1113 as billing", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isBillingErrorMessage(raw)).toBe(false);
    });
  });

  describe("existing patterns are unaffected", () => {
    it("rate limit still classified correctly", () => {
      expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    });

    it("billing still classified correctly", () => {
      expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    });

    it("auth still classified correctly", () => {
      expect(isAuthErrorMessage("invalid api key provided")).toBe(true);
    });
  });
});

describe("generic assistant error text classification (#93931)", () => {
  it("classifies the bare 'LLM request failed.' as a timeout (transient)", () => {
    // The generic error text wraps local-provider availability failures (model
    // not loaded, endpoint unreachable) that should engage retry/fallback. The
    // fork produces this exact text from assistant-failover.ts and the
    // lifecycle handlers.
    expect(isTimeoutErrorMessage("LLM request failed.")).toBe(true);
  });

  it("classifies lowercase 'llm request failed.' as a timeout (case-insensitive)", () => {
    expect(isTimeoutErrorMessage("llm request failed.")).toBe(true);
  });

  it("does NOT match the schema-rejection variant via the exact-match pattern", () => {
    // A format/schema error is not transient; it must fall through to its own
    // classification, not the generic LLM-request-failed match.
    expect(
      isTimeoutErrorMessage(
        "LLM request failed: provider rejected the request schema or tool payload.",
      ),
    ).toBe(false);
  });

  it("does NOT match the connection-refused variant via the exact-match pattern", () => {
    // The colon-suffixed sanitized variant must not be caught by the strict
    // /^llm request failed\.$/i regex.
    expect(
      isTimeoutErrorMessage("LLM request failed: connection refused by the provider endpoint."),
    ).toBe(false);
  });
});
