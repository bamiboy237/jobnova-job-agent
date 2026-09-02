import { AgentBrowser } from "@mastra/agent-browser";
import { StagehandBrowser, type ModelConfiguration } from "@mastra/stagehand";
import {
  BrowserbaseSession,
  CdpSession,
  installDialogAutoDismiss,
  LocalChromeSession,
} from "../browser/cdpSession.js";

export interface ResolverBrowsers {
  actionBrowser: AgentBrowser;
  interpretationBrowser: StagehandBrowser;
  release: () => Promise<void>;
  close: () => Promise<void>;
}

export function createResolverBrowsers(model: ModelConfiguration, requireLinkedInAuth = true, keepLocalBrowserAlive = false): ResolverBrowsers {
  const session: CdpSession = process.env.BROWSER_PROVIDER === "local"
    ? new LocalChromeSession({ requireLinkedInAuth, keepAlive: keepLocalBrowserAlive })
    : new BrowserbaseSession({ persistContext: false });
  const cdpUrl = () => session.connect();

  const actionBrowser = new AgentBrowser({
    cdpUrl,
    scope: "shared",
    viewport: { width: 1440, height: 1000 },
    timeout: 30_000,
    excludeTools: [
      "browser_type",
      "browser_press",
      "browser_select",
      "browser_hover",
      "browser_dialog",
      "browser_drag",
      "browser_screenshot",
      "browser_evaluate",
      "browser_close",
    ],
  });

  const interpretationBrowser = new StagehandBrowser({
    env: "LOCAL",
    cdpUrl,
    scope: "shared",
    model,
    viewport: { width: 1440, height: 1000 },
    selfHeal: true,
    domSettleTimeout: 3_000,
    verbose: 0,
    excludeTools: [
      "stagehand_act",
      "stagehand_navigate",
      "stagehand_tabs",
      "stagehand_close",
      "stagehand_screenshot",
    ],
  });

  installDialogAutoDismiss(actionBrowser);

  const release = async () => {
    await Promise.allSettled([
      actionBrowser.close(),
      interpretationBrowser.close(),
    ]);
    await session.release();
  };

  return {
    actionBrowser,
    interpretationBrowser,
    release,
    close: release,
  };
}

export { hasLinkedInAuthCookie } from "../browser/cdpSession.js";
