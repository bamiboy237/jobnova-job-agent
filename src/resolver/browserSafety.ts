export function collectEnvSecrets(): string[] {
  return [
    process.env.OPENAI_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.BROWSERBASE_API_KEY,
    process.env.MASTRA_DATABASE_AUTH_TOKEN,
  ].filter((secret): secret is string => Boolean(secret));
}

export function redactSensitiveText(value: string, secrets: string[] = []): string {
  let message = value;
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "***");
  }
  return message
    .replace(/wss:\/\/[^\s]+/g, "wss://***")
    .replace(/https:\/\/www\.browserbase\.com\/sessions\/[^\s]+/g, "https://www.browserbase.com/sessions/***");
}

export function safeError(error: unknown, secrets: string[] = []): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error), secrets);
}
