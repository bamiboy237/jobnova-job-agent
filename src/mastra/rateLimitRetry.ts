const fallbackDelaysMs = [5_000, 15_000, 30_000];
const maxProviderDelayMs = 65_000;

export function isRateLimitError(error: unknown): boolean {
  let current = error;
  while (current && typeof current === "object") {
    const value = current as Record<string, unknown>;
    if (value.statusCode === 429
      || value.responseBody?.toString().includes("RESOURCE_EXHAUSTED")
      || value.message?.toString().includes("quota")) return true;
    current = value.cause;
  }
  return false;
}

export function rateLimitRetryDelayMs(error: unknown, retryCount: number): number {
  let current = error;
  while (current && typeof current === "object") {
    const value = current as Record<string, unknown>;
    const text = [value.responseBody, value.message].filter((item) => typeof item === "string").join("\n");
    const seconds = text.match(/retry(?:Delay["']?\s*:\s*["']| in )(\d+(?:\.\d+)?)s/i)?.[1];
    if (seconds) return Math.min(Math.ceil(Number(seconds) * 1_000) + 1_000, maxProviderDelayMs);
    current = value.cause;
  }
  return fallbackDelaysMs[Math.min(retryCount, fallbackDelaysMs.length - 1)];
}
