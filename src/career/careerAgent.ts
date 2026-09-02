import { randomUUID } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { StreamErrorRetryProcessor } from "@mastra/core/processors";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import type { ResolverModelConfig } from "../mastra/model.js";
import { isRateLimitError, rateLimitRetryDelayMs } from "../mastra/rateLimitRetry.js";
import { getMastraStorage } from "../mastra/storage.js";
import { createResolverBrowsers } from "../mastra/resolverBrowser.js";
import { installDialogAutoDismiss } from "../browser/cdpSession.js";
import { captureFullPageScreenshot } from "../apply/applicationArtifacts.js";
import { createGeneralApplicationTools, type InteractiveAnswerStore } from "../apply/generalBrowserTools.js";
import type { CandidateFactCatalog } from "../apply/generalFacts.js";
import { finalAudit, isBoundConfirmation } from "../apply/generalSafety.js";
import { clickControlRef, clickUniqueButtonLabel, inspectControlRef, inspectCurrentPage } from "../apply/pageInspection.js";
import { isAllowedApplicationUrl, type PageControl } from "../apply/pageState.js";
import { createRunLedger, markSubmissionAttempted, type ApplicationRunLedger } from "../apply/runLedger.js";

export type CareerMode = "conversation" | "resolving" | "applying" | "complete";

export interface SavedContextField {
  key: string;
  label: string;
  inputType: "text" | "date" | "email" | "tel" | "number" | "select" | "boolean";
  value: string;
}

interface BoundAnswer {
  value: string;
  identity: string;
  groupIdentity?: string;
  kind: PageControl["kind"];
}

export interface CareerRuntimeState {
  mode: CareerMode;
  allowedUrls: Set<string>;
  currentJobUrl?: string;
  jobStartedAt?: number;
  ledger: ApplicationRunLedger;
  answers: Map<string, BoundAnswer>;
  context: Map<string, SavedContextField>;
}

const instructions = `You are Jobnova, a conversational career agent. Converse normally even when no job URL or application task has been supplied. Help the user understand a role and autonomously use your job tools when their request requires browser work.

You own orchestration. The client never decides workflow phases for you.

Job protocol:
1. When the user supplies a job URL and asks you to inspect, resolve, or apply, call open_supplied_job. Never invent or navigate to a URL from memory.
2. In resolution mode, inspect the current page with browser_snapshot. Use visible evidence and Stagehand interpretation when needed. General navigation and exact ref clicks are available only in this mode. Resolve LinkedIn listings to the matching external job-specific page.
3. When the browser reaches an application form, call enter_application_mode. Generic navigation and browser mutations are then blocked.
4. In application mode, use inspect_current_page and application_capabilities before mapping fields. Retrieve approved facts with one candidate_get call listing every key the page needs; use lookup_candidate_fact only for a single late semantic comparison.
4a. Batch by default. After one snapshot, map every field you can already satisfy on the visible page and complete them in ONE execute_application_actions call, including checkbox and radio clicks. Use the individual protected tools only to recover from a failed action or to handle a control that appeared afterwards. Set stopOnError=false when the fields are independent so one stale ref does not discard the rest, then reinspect once and retry only the failed refs. Reinspect after every dynamic barrier, upload, stale ref, or step advance.
5. If an exact private fact is unavailable or uncertain, call request_user_input for the specific fresh control. The client collects the value privately. You receive only an opaque answer handle; use fill_interactive_answer with that handle and a fresh ref.
6. Use saved_context_capabilities and prepare_saved_context_answer to reuse previously supplied private facts without seeing their values.
7. For model-generated free-form prose, call request_answer_approval with the draft and its specific control. Never enter generated prose before approval. Use the returned opaque handle after approval.
8. Never click final submit. After all required fields are complete, call request_submission. It performs guarded validation, asks the user for confirmation, makes at most one final click, and verifies the result.

Rules:
- Never invent candidate facts, company identity, job identity, URLs, or submission success.
- Never expose candidate values, private input, credentials, resume paths, browser refs, or raw tool payloads in assistant text.
- Respect the user's latest decision. If they decline an approval or submission, acknowledge it and do not ask again unless they later request that action.
- Never repeat an action that produced no new state.
- Several jobs may be handled sequentially in this conversation. A new supplied URL starts isolated job state without replacing the conversation thread or browser runtime.`;

const semanticKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/i);
const inputTypeSchema = z.enum(["text", "date", "email", "tel", "number", "select", "boolean"]);
const resolverOnlyBrowserTools = new Set(["browser_goto", "browser_click", "browser_back", "browser_tabs"]);

export function canUseBrowserMutation(mode: CareerMode, toolName: string): boolean {
  return !resolverOnlyBrowserTools.has(toolName) || mode === "resolving";
}

export function canUseApplicationTool(mode: CareerMode): boolean {
  return mode === "applying";
}

export function canUseStagehand(mode: CareerMode, privateInputEntered = false): boolean {
  return mode === "resolving" || (mode === "applying" && !privateInputEntered);
}

export function secureInputMetadata(control: PageControl, inputType: SavedContextField["inputType"]): Pick<SavedContextField, "label" | "inputType"> & { options: string[] } | undefined {
  const compatible = control.kind === "select" ? inputType === "select"
    : control.kind === "checkbox" ? inputType === "boolean"
      : control.kind === "radio" || control.kind === "option" ? inputType === "select" || inputType === "boolean"
        : control.kind === "combobox" || control.kind === "listbox" ? inputType === "select"
        : control.kind === "text" || control.kind === "textarea" ? !["select", "boolean"].includes(inputType)
          : false;
  if (!compatible) return undefined;
  return { label: control.label || "Application field", inputType, options: control.options.slice(0, 50) };
}

function ledgerProxy(state: CareerRuntimeState): ApplicationRunLedger {
  return {
    get completed() { return state.ledger.completed; },
    set completed(value) { state.ledger.completed = value; },
    get validatedFingerprints() { return state.ledger.validatedFingerprints; },
    set validatedFingerprints(value) { state.ledger.validatedFingerprints = value; },
    get latest() { return state.ledger.latest; },
    set latest(value) { state.ledger.latest = value; },
    get noProgressCount() { return state.ledger.noProgressCount; },
    set noProgressCount(value) { state.ledger.noProgressCount = value; },
    get submissionAttempted() { return state.ledger.submissionAttempted; },
    set submissionAttempted(value) { state.ledger.submissionAttempted = value; },
  };
}

function bindAnswer(state: CareerRuntimeState, control: PageControl, value: string): string {
  const answerId = `context.${randomUUID()}`;
  state.answers.set(answerId, { value, identity: control.identity, groupIdentity: control.groupIdentity, kind: control.kind });
  return answerId;
}

export function createCareerRuntime(modelConfig: ResolverModelConfig, catalog: CandidateFactCatalog, state: CareerRuntimeState, sessionId: string) {
  const browsers = createResolverBrowsers(modelConfig.browserModel, false, process.env.BROWSER_PROVIDER === "local");
  installDialogAutoDismiss(browsers.actionBrowser);
  const answerStore: InteractiveAnswerStore = { resolve: (answerId) => state.answers.get(answerId) };
  const applicationTools = createGeneralApplicationTools(browsers.actionBrowser, catalog, undefined, ledgerProxy(state), answerStore);
  const guardedApplicationTools = Object.fromEntries(Object.entries(applicationTools).map(([name, tool]) => [name, createTool({
    id: name,
    description: tool.description,
    inputSchema: tool.inputSchema as never,
    execute: async (input, context) => canUseApplicationTool(state.mode)
      ? tool.execute!(input, context as never)
      : { success: false, error: `${name} is available only on a locked application page` },
  })]));
  const rawBrowserTools = browsers.actionBrowser.getTools();
  const guardedBrowserTools = Object.fromEntries(Object.entries(rawBrowserTools).map(([name, tool]) => {
    if (name === "browser_snapshot") return [name, createTool({
      id: name,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      execute: async (input, context) => redactPrivateValues(await tool.execute!(input, context as never), [...state.context.values()].map((field) => field.value)),
    })];
    if (!resolverOnlyBrowserTools.has(name)) return [name, tool];
    return [name, createTool({
      id: name,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      execute: async (input, context) => canUseBrowserMutation(state.mode, name)
        ? tool.execute!(input, context as never)
        : { success: false, error: `${name} is available only while resolving a job source` },
    })];
  }));
  const thread = (agent?: { threadId?: string }) => {
    browsers.actionBrowser.setCurrentThread(agent?.threadId);
    return agent?.threadId;
  };
  const syncStagehandPage = async (agent?: { threadId?: string }) => {
    const threadId = thread(agent);
    browsers.interpretationBrowser.setCurrentThread(threadId);
    await browsers.interpretationBrowser.ensureReady();
    const actionManager = await browsers.actionBrowser.getManagerForThread(threadId);
    const stagehand = await browsers.interpretationBrowser.getManagerForThread(threadId);
    const context = stagehand?.context;
    if (!context) return;
    const actionPage = actionManager.getPage();
    const target = context.pages().find((page) => page.url() === actionPage.url())
      ?? context.pages()[actionManager.getActiveIndex()];
    if (target && target !== context.activePage()) context.setActivePage(target);
  };
  const requireApplicationControl = async (ref: string, agent?: { threadId?: string }) => {
    if (state.mode !== "applying") return { error: "Secure input is available only on an application", control: undefined };
    const control = await inspectControlRef(browsers.actionBrowser, ref, thread(agent));
    if (!control || !control.visible || !control.enabled) return { error: "The requested application control is stale or unavailable", control: undefined };
    return { control };
  };
  const careerTools = {
    open_supplied_job: createTool({
      id: "open_supplied_job",
      description: "Open one exact job URL supplied in the latest user message and begin isolated job work.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }, { agent }) => {
        if (!state.allowedUrls.has(url) || !isAllowedApplicationUrl(url)) return { success: false, error: "URL was not supplied by the user in the current turn" };
        state.mode = "resolving";
        state.currentJobUrl = url;
        state.jobStartedAt = Date.now();
        state.ledger = createRunLedger();
        state.answers.clear();
        const threadId = thread(agent);
        await browsers.actionBrowser.ensureReady();
        const manager = await browsers.actionBrowser.getManagerForThread(threadId);
        await manager.getPage().goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return { success: true, mode: state.mode, url };
      },
    }),
    enter_application_mode: createTool({
      id: "enter_application_mode",
      description: "Lock the current visible application page into guarded application mode after resolution.",
      inputSchema: z.object({}),
      execute: async (_input, { agent }) => {
        if (state.mode !== "resolving") return { success: false, error: "No job is being resolved" };
        const page = await inspectCurrentPage(browsers.actionBrowser, [], thread(agent));
        if (page.intent !== "application") return { success: false, error: "Current page is not a visible application form", intent: page.intent };
        state.mode = "applying";
        state.currentJobUrl = page.url;
        return { success: true, mode: state.mode, url: page.url };
      },
    }),
    saved_context_capabilities: createTool({
      id: "saved_context_capabilities",
      description: "List value-free private context keys that can be bound to application controls.",
      inputSchema: z.object({}),
      execute: async () => ({ fields: [...state.context.values()].map(({ key, label, inputType }) => ({ key, label, inputType })) }),
    }),
    prepare_saved_context_answer: createTool({
      id: "prepare_saved_context_answer",
      description: "Bind one saved private context field to its exact current control and return an opaque fill handle.",
      inputSchema: z.object({ ref: z.string(), key: semanticKeySchema }),
      execute: async ({ ref, key }, { agent }) => {
        const saved = state.context.get(key);
        if (!saved) return { success: false, error: "Saved context key is unavailable" };
        const inspected = await requireApplicationControl(ref, agent);
        if (!inspected.control) return { success: false, error: inspected.error };
        if (!secureInputMetadata(inspected.control, saved.inputType)) return { success: false, error: "Saved context type is incompatible with this control" };
        return { success: true, answerId: bindAnswer(state, inspected.control, saved.value), key };
      },
    }),
    request_user_input: createTool({
      id: "request_user_input",
      description: "Suspend for one typed private user value bound to a specific current application control. The value is never returned to the model.",
      inputSchema: z.object({ ref: z.string(), key: semanticKeySchema, inputType: inputTypeSchema, description: z.string().max(500).optional(), formatHint: z.string().max(80).optional() }),
      suspendSchema: z.object({ kind: z.literal("user_input"), requestId: z.string(), label: z.string(), inputType: inputTypeSchema, description: z.string().optional(), formatHint: z.string().optional(), options: z.array(z.string()), key: z.string() }),
      resumeSchema: z.object({ value: z.string() }),
      execute: async ({ ref, key, inputType, description, formatHint }, { agent }) => {
        const inspected = await requireApplicationControl(ref, agent);
        if (!inspected.control) return { success: false, error: inspected.error };
        const metadata = secureInputMetadata(inspected.control, inputType);
        if (!metadata) return { success: false, error: "Requested input type is incompatible with this control" };
        if (!agent?.resumeData) {
          await agent?.suspend({ kind: "user_input", requestId: agent.toolCallId, label: metadata.label, inputType: metadata.inputType, description, formatHint, options: metadata.options, key });
          return;
        }
        const value = agent.resumeData.value;
        state.context.set(key, { key, label: metadata.label, inputType: metadata.inputType, value });
        return { success: true, answerId: bindAnswer(state, inspected.control, value), key };
      },
    }),
    request_answer_approval: createTool({
      id: "request_answer_approval",
      description: "Show one generated free-form answer in chat and suspend until the user approves, edits, or declines it.",
      inputSchema: z.object({ ref: z.string(), key: semanticKeySchema, label: z.string().min(1).max(160), draft: z.string().min(1).max(5000) }),
      suspendSchema: z.object({ kind: z.literal("answer_approval"), requestId: z.string(), label: z.string(), draft: z.string(), key: z.string() }),
      resumeSchema: z.object({ approved: z.boolean(), value: z.string().optional() }),
      execute: async ({ ref, key, label, draft }, { agent }) => {
        const inspected = await requireApplicationControl(ref, agent);
        if (!inspected.control) return { success: false, error: inspected.error };
        if (!agent?.resumeData) {
          await agent?.suspend({ kind: "answer_approval", requestId: agent.toolCallId, label, draft, key });
          return;
        }
        if (!agent.resumeData.approved) return { success: false, declined: true };
        const value = agent.resumeData.value ?? draft;
        state.context.set(key, { key, label, inputType: "text", value });
        return { success: true, answerId: bindAnswer(state, inspected.control, value), key };
      },
    }),
    request_submission: createTool({
      id: "request_submission",
      description: "Validate the current application, ask the user for confirmation, then perform and verify at most one final submission click.",
      inputSchema: z.object({}),
      suspendSchema: z.object({ kind: z.literal("submission"), requestId: z.string(), prompt: z.string(), completedFields: z.number(), screenshotPath: z.string() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: async (_input, { agent }) => {
        if (state.mode !== "applying") return { success: false, error: "No application is ready for submission" };
        const threadId = thread(agent);
        const before = await inspectCurrentPage(browsers.actionBrowser, [], threadId);
        const audit = finalAudit(before, state.ledger.completed.length);
        if (!audit.ok) return { success: false, error: audit.error, missingRequired: audit.missingRequired };
        const screenshotPath = await captureFullPageScreenshot(browsers.actionBrowser, sessionId, "ready");
        if (!screenshotPath) return { success: false, error: "Could not capture required pre-submit screenshot" };
        if (!agent?.resumeData) {
          await agent?.suspend({ kind: "submission", requestId: agent.toolCallId, prompt: "Submit this validated application?", completedFields: state.ledger.completed.length, screenshotPath });
          return;
        }
        if (!agent.resumeData.approved) return { success: false, declined: true, status: "ready_to_submit" };
        const fresh = await inspectCurrentPage(browsers.actionBrowser, [], threadId);
        const freshAudit = finalAudit(fresh, state.ledger.completed.length);
        if (!freshAudit.ok || !freshAudit.final || !markSubmissionAttempted(state.ledger)) return { success: false, error: freshAudit.error ?? "Submission was already attempted" };
        if (freshAudit.final.snapshotRef) await clickControlRef(browsers.actionBrowser, freshAudit.final.snapshotRef, threadId);
        else await clickUniqueButtonLabel(browsers.actionBrowser, freshAudit.final.label, threadId);
        const after = await inspectCurrentPage(browsers.actionBrowser, [], threadId);
        if (!isBoundConfirmation(fresh, after)) return { success: false, error: "Submission click outcome is uncertain; it was not repeated" };
        state.mode = "complete";
        return { success: true, status: "submitted", applicationId: after.applicationId, screenshotPath };
      },
    }),
  };
  const stagehandTools = browsers.interpretationBrowser.getTools();
  const guardedStagehandTools = Object.fromEntries(["stagehand_extract", "stagehand_observe"].map((name) => {
    const tool = stagehandTools[name];
    return [name, createTool({
      id: name,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      execute: async (input, context) => {
        if (!canUseStagehand(state.mode, state.ledger.completed.some((completion) => completion.source === "answer" && completion.key.startsWith("context.")))) {
          return { success: false, error: `${name} is unavailable after private application data can be entered` };
        }
        await syncStagehandPage(context.agent);
        return tool.execute!(input, context as never);
      },
    })];
  }));
  const careerAgent = new Agent({
    id: "career-agent",
    name: "Jobnova career agent",
    description: "Converses about jobs and autonomously resolves and applies through guarded browser tools.",
    instructions,
    model: modelConfig.agentModel,
    memory: new Memory({ options: { lastMessages: 60 } }),
    tools: {
      ...guardedBrowserTools,
      ...guardedStagehandTools,
      ...guardedApplicationTools,
      ...careerTools,
    },
    errorProcessors: [new StreamErrorRetryProcessor({
      maxRetries: 2,
      delayMs: ({ retryCount }) => [5_000, 15_000][Math.min(retryCount, 1)],
      matchers: [{
        match: isRateLimitError,
        maxRetries: 3,
        delayMs: ({ error, retryCount }) => rateLimitRetryDelayMs(error, retryCount),
        onRetry: ({ delayMs }) => {
          console.warn(`[AGENT] Model rate limited; retrying in ${Math.ceil(delayMs / 1_000)}s`);
        },
      }],
    })],
    maxRetries: 0,
    maxProcessorRetries: 3,
  });
  const mastra = new Mastra({
    storage: getMastraStorage(),
    agents: { careerAgent },
  });
  return { mastra, browsers };
}

function redactPrivateValues(value: unknown, privateValues: string[]): unknown {
  if (typeof value === "string") return privateValues.reduce((text, privateValue) => privateValue ? text.split(privateValue).join("[private value]") : text, value);
  if (Array.isArray(value)) return value.map((item) => redactPrivateValues(item, privateValues));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPrivateValues(item, privateValues)]));
  return value;
}
