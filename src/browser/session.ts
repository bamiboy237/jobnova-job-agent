import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import path from "node:path";
import fs from "node:fs/promises";

export const LOCAL_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const LOCAL_BROWSER_PROFILE_DIR = path.resolve(process.cwd(), ".local-chrome-profile");
export const LOCAL_BROWSER_STATE_PATH = path.resolve(process.cwd(), ".local-browser-state.json");

export async function loadLocalBrowserCookies(): Promise<any[]> {
  try {
    const state = JSON.parse(await fs.readFile(LOCAL_BROWSER_STATE_PATH, "utf8"));
    return Array.isArray(state.cookies) ? state.cookies : [];
  } catch {
    return [];
  }
}

export async function saveLocalBrowserState(context: BrowserContext): Promise<void> {
  await context.storageState({ path: LOCAL_BROWSER_STATE_PATH });
}

export interface BrowserSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  inspectorUrl: string;
  close: () => Promise<void>;
}

export async function createRemoteSession(options?: {
  persistContext?: boolean;
}): Promise<BrowserSession> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const contextId = process.env.BROWSERBASE_CONTEXT_ID;

  if (!apiKey || !projectId) {
    throw new Error("Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID in environment");
  }

  const bb = new Browserbase({ apiKey });
  const shouldPersist = options?.persistContext ?? true;

  const session = await bb.sessions.create({
    projectId,
    browserSettings: contextId
      ? {
          context: {
            id: contextId,
            persist: shouldPersist,
          },
        }
      : undefined,
  });

  const inspectorUrl = `https://www.browserbase.com/sessions/${session.id}`;
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  return {
    sessionId: session.id,
    browser,
    context,
    page,
    inspectorUrl,
    close: async () => {
      try {
        await browser.close();
      } catch {
        // Safe close ignoring disconnect race
      }
    },
  };
}

export async function createLocalSession(): Promise<Omit<BrowserSession, "browser">> {
  const context = await chromium.launchPersistentContext(LOCAL_BROWSER_PROFILE_DIR, {
    executablePath: LOCAL_CHROME_PATH,
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();

  return {
    sessionId: "local",
    context,
    page,
    inspectorUrl: "",
    close: () => context.close(),
  };
}
