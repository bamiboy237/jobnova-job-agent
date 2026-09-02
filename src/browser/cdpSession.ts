import Browserbase from "@browserbasehq/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AgentBrowser } from "@mastra/agent-browser";
import {
  loadLocalBrowserCookies,
  LOCAL_BROWSER_PROFILE_DIR,
  LOCAL_CHROME_PATH,
} from "./session.js";

/**
 * One CDP browser session shared sequentially by StagehandBrowser and
 * AgentBrowser. `connect()` is lazy and memoized; `release()` closes it.
 *
 * Local development launches the existing local Chrome profile over CDP.
 * Production uses Browserbase remote Chromium.
 */
export interface CdpSession {
  connect(): Promise<string>;
  release(): Promise<void>;
}

export class BrowserbaseSession implements CdpSession {
  private browserbase?: Browserbase;
  private session?: { id: string; connectUrl: string };
  private connecting?: Promise<string>;
  private readonly persistContext: boolean;

  constructor(options?: { persistContext?: boolean }) {
    this.persistContext = options?.persistContext ?? false;
  }

  connect(): Promise<string> {
    this.connecting ??= this.create().catch((error) => {
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  async release(): Promise<void> {
    await this.connecting?.catch(() => {});
    if (!this.session || !this.browserbase) return;
    await this.browserbase.sessions.update(this.session.id, { status: "REQUEST_RELEASE" }).catch(() => {});
  }

  private async create(): Promise<string> {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) {
      throw new Error("Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID in environment");
    }

    this.browserbase = new Browserbase({ apiKey });
    const contextId = process.env.BROWSERBASE_CONTEXT_ID;
    const session = await this.browserbase.sessions.create({
      projectId,
      api_timeout: 300,
      browserSettings: {
        solveCaptchas: true,
        ...(contextId ? { context: { id: contextId, persist: this.persistContext } } : {}),
      },
    });
    this.session = { id: session.id, connectUrl: session.connectUrl };
    return session.connectUrl;
  }
}

export class LocalChromeSession implements CdpSession {
  private process?: ChildProcess;
  private bootstrapBrowser?: Browser;
  private connecting?: Promise<string>;
  private readonly requireLinkedInAuth: boolean;
  private readonly keepAlive: boolean;
  private ownsProcess = false;

  constructor(options?: { requireLinkedInAuth?: boolean; keepAlive?: boolean }) {
    this.requireLinkedInAuth = options?.requireLinkedInAuth ?? true;
    this.keepAlive = options?.keepAlive ?? false;
  }

  connect(): Promise<string> {
    this.connecting ??= this.launch();
    return this.connecting;
  }

  async release(): Promise<void> {
    await this.bootstrapBrowser?.close().catch(() => {});
    if (this.keepAlive || !this.ownsProcess) return;
    const process = this.process;
    if (!process || process.exitCode !== null) return;
    process.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => process.once("exit", () => resolve())),
      delay(3_000),
    ]);
    if (process.exitCode === null) process.kill("SIGKILL");
  }

  private async launch(): Promise<string> {
    const runningEndpoint = await readRunningLocalChromeEndpoint();
    if (runningEndpoint) {
      this.ownsProcess = false;
      return runningEndpoint;
    }

    const port = await availablePort();
    this.process = spawn(LOCAL_CHROME_PATH, [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${LOCAL_BROWSER_PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { stdio: "ignore" });
    this.ownsProcess = true;
    if (this.keepAlive) this.process.unref();

    const endpoint = `http://127.0.0.1:${port}/json/version`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.process.exitCode !== null) throw new Error("Local Chrome exited before its CDP endpoint became ready");
      try {
        const response = await fetch(endpoint);
        if (response.ok) {
          const body = await response.json() as { webSocketDebuggerUrl?: string };
          if (body.webSocketDebuggerUrl) {
            await this.restoreSavedAuth(body.webSocketDebuggerUrl);
            return body.webSocketDebuggerUrl;
          }
        }
      } catch {
        // Chrome has not opened the CDP endpoint yet.
      }
      await delay(100);
    }
    throw new Error("Local Chrome CDP endpoint did not become ready within 10 seconds");
  }

  private async restoreSavedAuth(cdpUrl: string): Promise<void> {
    const cookies = await loadLocalBrowserCookies();
    if (!hasLinkedInAuthCookie(cookies)) {
      if (this.requireLinkedInAuth) {
        throw new Error("Local LinkedIn authentication is missing; run npm run auth before resolving jobs");
      }
      return;
    }

    this.bootstrapBrowser = await chromium.connectOverCDP(cdpUrl);
    const context = this.bootstrapBrowser.contexts()[0];
    if (!context) throw new Error("Local Chrome did not expose a browser context");
    await context.addCookies(cookies);
  }
}

async function readRunningLocalChromeEndpoint(): Promise<string | undefined> {
  try {
    const [portText] = (await fs.readFile(`${LOCAL_BROWSER_PROFILE_DIR}/DevToolsActivePort`, "utf8")).split(/\r?\n/);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return undefined;
    const body = await response.json() as { webSocketDebuggerUrl?: string };
    return body.webSocketDebuggerUrl;
  } catch {
    return undefined;
  }
}

export function hasLinkedInAuthCookie(cookies: Array<{ name?: string; value?: string }>): boolean {
  return cookies.some((cookie) => cookie.name === "li_at" && Boolean(cookie.value));
}

/** Installs one guarded dialog dismissal after AgentBrowser has connected. */
export function installDialogAutoDismiss(browser: AgentBrowser): void {
  const guarded = browser as AgentBrowser & { __jobnovaDialogGuardInstalled?: boolean };
  if (guarded.__jobnovaDialogGuardInstalled) return;
  guarded.__jobnovaDialogGuardInstalled = true;
  const ensureReady = browser.ensureReady.bind(browser);
  browser.ensureReady = async () => {
    await ensureReady();
    try {
      const manager = await browser.getManagerForThread(undefined as unknown as string);
      // One context-level listener covers every page, including tabs opened
      // later (Playwright auto-dismisses, with a crash-prone race, only when
      // neither a page nor a context dialog listener exists).
      const context = manager.getPage().context() as ReturnType<Page["context"]> & { __jobnovaDialogHandlerAttached?: boolean };
      if (context.__jobnovaDialogHandlerAttached) return;
      context.on("dialog", (dialog) => {
        // Accepting beforeunload lets navigation proceed (Playwright's own
        // no-listener behavior); everything else is dismissed.
        const close = dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss();
        close.catch(() => {
          // The dialog may already be gone; never let this reject.
        });
      });
      context.__jobnovaDialogHandlerAttached = true;
    } catch {
      // Dialog handling must not make an otherwise ready browser fail.
    }
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local Chrome debugging port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
