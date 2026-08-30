import { type Page } from "playwright-core";

export function safeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "***");
  }
  return message
    .replace(/wss:\/\/[^\s]+/g, "wss://***")
    .replace(/https:\/\/www\.browserbase\.com\/sessions\/[^\s]+/g, "https://www.browserbase.com/sessions/***");
}

export async function checkLinkedInAuthWall(page: Page): Promise<boolean> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(page.url());
  } catch {
    return false;
  }

  if (parsedUrl.hostname !== "linkedin.com" && !parsedUrl.hostname.endsWith(".linkedin.com")) {
    return false;
  }

  const url = parsedUrl.href.toLowerCase();
  if (
    url.includes("/authwall") ||
    url.includes("/login") ||
    url.includes("/checkpoint") ||
    url.includes("/signup") ||
    url.includes("/cold-join") ||
    url.includes("/challenge") ||
    url.includes("/verification")
  ) {
    return true;
  }

  return page.evaluate(() => (
    document.querySelector(".authwall-join-form") !== null ||
    document.querySelector("form.login__form") !== null ||
    document.querySelector("form[action*='cold-join']") !== null ||
    (document.body.innerText.includes("Join LinkedIn") && !document.querySelector("h1"))
  ));
}
