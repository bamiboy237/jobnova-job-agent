import { describe, expect, it } from "vitest";
import { isRateLimitError, rateLimitRetryDelayMs } from "../src/mastra/rateLimitRetry.js";

describe("rate-limit retry", () => {
  it("uses the provider retry delay with a small reset-window buffer", () => {
    const error = {
      statusCode: 429,
      responseBody: JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "59.052s" }],
        },
      }),
    };

    expect(isRateLimitError(error)).toBe(true);
    expect(rateLimitRetryDelayMs(error, 0)).toBe(60_052);
  });

  it("uses bounded progressive waits when the provider supplies no delay", () => {
    const error = { statusCode: 429 };

    expect([0, 1, 2, 3].map((retryCount) => rateLimitRetryDelayMs(error, retryCount)))
      .toEqual([5_000, 15_000, 30_000, 30_000]);
    expect(isRateLimitError(new Error("invalid request"))).toBe(false);
  });
});
