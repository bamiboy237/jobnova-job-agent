import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import type { ResolverModelConfig } from "./model.js";
import { createResolverBrowsers } from "./resolverBrowser.js";
import { getMastraStorage } from "./storage.js";

export const ResolverAgentOutputSchema = z.object({
  company: z.string().describe("Exact hiring company from the LinkedIn listing, or empty string"),
  jobTitle: z.string().describe("Exact complete job title from the LinkedIn listing, or empty string"),
  location: z.string().describe("Visible listing location, or empty string"),
  candidateUrl: z.string().describe("Best job-specific external HTTPS candidate URL, or empty string"),
  pageType: z.enum(["job", "careers", "homepage", "other"]),
  companyMatches: z.boolean(),
  jobMatches: z.boolean(),
  companyEvidence: z.string().describe("Direct visible quote supporting the company match, or empty string"),
  jobEvidence: z.string().describe("Direct visible quote supporting the exact role match, or empty string"),
  blocker: z.string().describe("Specific blocker when no candidate can be verified, or empty string"),
});

export type ResolverAgentOutput = z.infer<typeof ResolverAgentOutputSchema>;

const instructions = `You resolve one LinkedIn job listing to its matching job-specific external page.

Browser protocol:
1. Use browser_goto to open the supplied LinkedIn URL, then browser_snapshot to read the fresh accessibility tree and refs.
2. Read visible company, complete job title, location, requisition, and Apply controls directly from the current snapshot when they are clear.
3. Use stagehand_extract only when page identity or destination evidence remains unresolved. Use stagehand_observe only when the current snapshot does not expose a reliable Apply or careers action. Stagehand interprets only; it never executes browser actions.
4. Locate the chosen action in current snapshot refs and execute it with browser_click. Capture popup or redirect state with browser_tabs and a fresh browser_snapshot.
5. Preserve every meaningful external job candidate. A failed or uncertain semantic check must not make you forget a candidate.
6. Inspect the destination snapshot deterministically. If company, exact title, requisition, or direct LinkedIn provenance forms a strong match, collect the visible evidence.
7. If the destination remains uncertain, use stagehand_extract to interpret that destination, then inspect it again before finishing.
8. If LinkedIn has no external Apply destination, inspect visible company and official-site evidence first. Use Stagehand only for unresolved evidence or action choice, then use AgentBrowser refs to execute one action. Repeat snapshot -> interpretation when needed -> one deterministic action until the exact job page or a blocker.

Rules:
- Never apply, sign in, submit a form, or invent candidate facts.
- Never guess a company domain, job URL, company relationship, or job identity from model memory.
- Reject generic careers/search pages as final destinations.
- Job identity can outweigh literal brand equality only when the current page visibly establishes the parent, subsidiary, division, or facility relationship.
- Stagehand answers "what is this / what should happen". AgentBrowser performs every exact navigation, click, keypress, and snapshot.
- Call browser_snapshot after every page-changing action. Refs are ephemeral and only valid for the latest snapshot.
- Do not repeat the same navigation or action when it produced no new state.
- If the LinkedIn listing is unavailable, blocked, or lacks real company/title identity, return a specific blocker. "Unknown", "N/A", and similar placeholders are not identities.
- Finish with the strongest candidate and direct visible evidence. Do not claim success; deterministic code makes the final decision.`;

export function createResolverRuntime(modelConfig: ResolverModelConfig) {
  const browsers = createResolverBrowsers(modelConfig.browserModel);
  const stagehandTools = browsers.interpretationBrowser.getTools();
  const resolverAgent = new Agent({
    id: "linkedin-resolver",
    name: "LinkedIn job source resolver",
    description: "Finds and verifies the job-specific external destination for one LinkedIn listing.",
    instructions,
    model: modelConfig.agentModel,
    memory: new Memory({ options: { lastMessages: 40 } }),
    browser: browsers.actionBrowser,
    tools: {
      stagehand_extract: stagehandTools.stagehand_extract,
      stagehand_observe: stagehandTools.stagehand_observe,
    },
    maxRetries: 1,
    maxProcessorRetries: 0,
  });
  const mastra = new Mastra({
    storage: getMastraStorage(),
    agents: { resolverAgent },
  });
  return { mastra, browsers };
}
