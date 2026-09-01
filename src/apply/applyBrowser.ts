import { AgentBrowser } from "@mastra/agent-browser";
import { StagehandBrowser, type ModelConfiguration } from "@mastra/stagehand";
import {
  BrowserbaseSession,
  CdpSession,
  installDialogAutoDismiss,
  LocalChromeSession,
} from "../browser/cdpSession.js";

export interface ApplyBrowsers {
  actionBrowser: AgentBrowser;
  interpretationBrowser: StagehandBrowser;
  close: () => Promise<void>;
}

/**
 * Browser runtime for the Lever application agent. One CDP session is
 * shared sequentially: AgentBrowser owns every exact action (goto,
 * snapshot, ref-based click/type/select), StagehandBrowser only interprets
 * (extract/observe). The local path does not require LinkedIn
 * authentication because Lever applications are public.
 *
 * browser_press and browser_evaluate are never exposed, and the agent has
 * no screenshot tool — the full-page screenshot is captured by the
 * controller only after validation succeeds.
 * browser_scroll remains exposed because this installed tool only changes the
 * current page viewport; tab creation and all raw navigation/mutation tools are excluded.
 */
export function createApplyBrowsers(model: ModelConfiguration): ApplyBrowsers {
  const session: CdpSession = process.env.BROWSER_PROVIDER === "local"
    ? new LocalChromeSession({ requireLinkedInAuth: false })
    : new BrowserbaseSession({ persistContext: false });
  const cdpUrl = () => session.connect();

  const actionBrowser = new AgentBrowser({
    cdpUrl,
    scope: "shared",
    viewport: { width: 1440, height: 1000 },
    timeout: 30_000,
    excludeTools: [
      "browser_press",
      "browser_hover",
      "browser_dialog",
      "browser_drag",
      "browser_screenshot",
      "browser_evaluate",
      "browser_close",
      "browser_back",
      "browser_goto",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_tabs",
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

  return {
    actionBrowser,
    interpretationBrowser,
    close: async () => {
      await Promise.allSettled([
        actionBrowser.close(),
        interpretationBrowser.close(),
      ]);
      await session.release();
    },
  };
}
