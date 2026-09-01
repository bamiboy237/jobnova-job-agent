import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { Memory } from "@mastra/memory";
import type { ResolverModelConfig } from "../mastra/model.js";
import { getMastraStorage } from "../mastra/storage.js";
import { createApplyBrowsers } from "./applyBrowser.js";
import { createGeneralApplicationTools, type CredentialHandles, type InteractiveAnswerStore } from "./generalBrowserTools.js";
import type { CandidateFactCatalog } from "./generalFacts.js";
import type { ApplicationRunLedger } from "./runLedger.js";

const instructions = `You complete one unfamiliar job application using only approved facts and reusable answers supplied in the task. You never submit.

Browser protocol:
1. The controller already opened the goal URL. Use browser_snapshot for fresh refs and inspect_current_page for dynamic control state. Use browser_wait when the form has not rendered yet.
2. After the first snapshot and inspection, call application_capabilities and compare the required controls with its value-free manifest. Call candidate_get once for the relevant semantic fact and reusable-answer values (up to 30 total); prefer it over singular lookup_candidate_fact and lookup_reusable_answer. Use exact fact tools directly when straightforward.
3. Use stagehand_extract or stagehand_observe only when a field's meaning or interaction remains uncertain (custom selects, date pickers, hidden sections). Stagehand only interprets; it never acts.
4. For a looked-up string fact, you may map it semantically to one visible radio/ARIA option or pass one exact visible option label to select_fact. Do not blindly try radio refs. Batch stable independent form entries with execute_application_actions; it runs sequentially and supports only fill_fact, select_fact, choose_fact_option, fill_reusable_answer, fill_interactive_answer, and upload_approved_resume. Do not batch navigation, authentication, progression, final submission, or generic clicks. Ask for interactive input only after approved facts, reusable answers, and browser resolution cannot complete the field. Keep individual tools for dynamic recovery. Use click_reversible only for safe choices or Previous/Back. Use advance_step only for an explicit Next control after required fields are complete; unknown progression blocks.
5. Refresh snapshot and inspect state after dynamic barriers, navigation, stale-ref errors, uploads, and step advance.
6. After filling approved credentials, use submit_authentication only for a structurally verified login form, then inspect. Stop and report a blocker for MFA, email verification, account creation, or CAPTCHA.

Rules:
- Never use a final submit control. The controller owns that one irreversible click.
- Never click a file control. Only upload_approved_resume may upload.
- Never run browser mutations concurrently. execute_application_actions is one model step but performs its actions sequentially.
- Never invent facts. Every entered value must use an approved fact key or reusable answer key.
- Respond conversationally to user messages, but never repeat candidate values, credentials, resume paths, browser refs, or raw tool payloads in assistant text.
- Do not repeat the same action when it produced no new state.
- Finish by listing exactly which fields you completed and which required fields remain missing, with a specific blocker only when the form cannot be completed.`;

export function createApplyRuntime(modelConfig: ResolverModelConfig, catalog: CandidateFactCatalog = { facts: {}, reusableAnswers: {} }, credentials?: CredentialHandles, ledger?: ApplicationRunLedger, interactiveAnswers?: InteractiveAnswerStore) {
  const browsers = createApplyBrowsers(modelConfig.browserModel);
  const stagehandTools = browsers.interpretationBrowser.getTools();
  const applyAgent = new Agent({
    id: "general-application-agent",
    name: "General application agent",
    description: "Completes unfamiliar applications from approved facts up to the controller-owned submit boundary.",
    instructions,
    model: modelConfig.agentModel,
    memory: new Memory({ options: { lastMessages: 40 } }),
    browser: browsers.actionBrowser,
    tools: {
      stagehand_extract: stagehandTools.stagehand_extract,
      stagehand_observe: stagehandTools.stagehand_observe,
      ...createGeneralApplicationTools(browsers.actionBrowser, catalog, credentials, ledger, interactiveAnswers),
    },
    maxRetries: 1,
    maxProcessorRetries: 0,
  });
  const mastra = new Mastra({
    storage: getMastraStorage(),
    agents: { applyAgent },
  });
  return { mastra, browsers };
}
