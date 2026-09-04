import { randomUUID } from "node:crypto";
import { getResolverModelConfig } from "../mastra/model.js";
import { compactSupersededSnapshots } from "../mastra/compactSnapshots.js";
import { collectEnvSecrets, safeError } from "../resolver/browserSafety.js";
import { createApplyRuntime } from "./applyAgent.js";
import { captureFullPageScreenshot } from "./applicationArtifacts.js";
import type { CredentialHandles, InteractiveAnswerStore } from "./generalBrowserTools.js";
import type { CandidateFactCatalog } from "./generalFacts.js";
import { isTrustedCapability } from "./generalFacts.js";
import { finalAudit, isBoundConfirmation } from "./generalSafety.js";
import { clickControlRef, clickUniqueButtonLabel, inspectCurrentPage } from "./pageInspection.js";
import { isAllowedApplicationUrl, requiredGaps, type PageControl, type PageState } from "./pageState.js";
import { createRunLedger, markSubmissionAttempted } from "./runLedger.js";
import { ApplicationResultSchema, type ApplicationResult } from "./applicationResult.js";

const MAX_APPLY_STEPS = 40;
export interface ApplyJobInput { applicationUrl: string; catalog: CandidateFactCatalog; credentials?: CredentialHandles; resumeId?: string; submit?: boolean; }
export interface ApplyJobDependencies {
  getConfig: typeof getResolverModelConfig; createRuntime: typeof createApplyRuntime; inspect: typeof inspectCurrentPage;
  screenshot: typeof captureFullPageScreenshot; clickRef: typeof clickControlRef; clickLabel: typeof clickUniqueButtonLabel; createRunId: () => string; now: () => number; wait: (milliseconds: number) => Promise<void>;
}
const productionDependencies: ApplyJobDependencies = { getConfig: getResolverModelConfig, createRuntime: createApplyRuntime, inspect: inspectCurrentPage, screenshot: captureFullPageScreenshot, clickRef: clickControlRef, clickLabel: clickUniqueButtonLabel, createRunId: randomUUID, now: Date.now, wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };

export interface InteractiveInputRequest { requestId: string; label: string; kind: PageControl["kind"]; options: string[]; }
export type ApplicationRunOutcome = ApplicationResult
  | { status: "needs_input"; requests: InteractiveInputRequest[] }
  | { status: "needs_takeover"; reason: "authentication" | "human_verification"; instructions: string };
export interface InteractiveAnswer { requestId: string; value: string; }
export type ApplicationEvent =
  | { type: "session_started"; threadId: string }
  | { type: "status"; status: "starting" | "thinking" | "inspecting"; detail: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool"; phase: "started" | "completed" | "failed"; toolCallId: string; name: string }
  | { type: "outcome"; outcome: ApplicationRunOutcome }
  | { type: "interrupted" };
export interface ApplicationRun {
  readonly startedAt: number;
  start(): AsyncIterable<ApplicationEvent>;
  sendMessage(message: string): AsyncIterable<ApplicationEvent>;
  provideAnswers(answers: InteractiveAnswer[]): AsyncIterable<ApplicationEvent>;
  resumeAfterTakeover(): AsyncIterable<ApplicationEvent>;
  interrupt(): void;
  continue(answers?: InteractiveAnswer[]): Promise<ApplicationRunOutcome>;
  submit(): Promise<ApplicationResult>;
  close(): Promise<void>;
}
interface StoredAnswer { value?: string; identity: string; groupIdentity?: string; kind: PageControl["kind"]; fingerprint: string; label: string; }

export function buildApplicationPrompt(input: ApplyJobInput): string {
  return `Complete the application at ${input.applicationUrl}. Approved fact keys: ${Object.keys(input.catalog.facts).join(", ") || "none"}. Approved reusable-answer keys: ${Object.keys(input.catalog.reusableAnswers).join(", ") || "none"}. Credential handles available: ${input.credentials?.handles?.join(", ") || "none"}. Approved resume id: ${input.resumeId ?? input.catalog.approvedResumeId ?? "none"}. Never submit.`;
}
export function canAttemptInitialAuthentication(credentials?: CredentialHandles): boolean { return Boolean(credentials?.handles?.length); }
export function isSafePromptIdentifier(value: string): boolean { return isTrustedCapability("fact", value) || isTrustedCapability("answer", value) || isTrustedCapability("resume", value) || isTrustedCapability("credential", value); }
export function unsafePromptIdentifier(input: ApplyJobInput): string | undefined {
  return Object.keys(input.catalog.facts).find((value) => !isTrustedCapability("fact", value))
    ?? Object.keys(input.catalog.reusableAnswers).find((value) => !isTrustedCapability("answer", value))
    ?? [input.resumeId, input.catalog.approvedResumeId].filter((value): value is string => Boolean(value)).find((value) => !isTrustedCapability("resume", value))
    ?? (input.credentials?.handles ?? []).find((value) => !isTrustedCapability("credential", value));
}

/** Creates one controller-owned browser run. It remains open only while input is needed or it is ready. */
export function createApplicationRun(input: ApplyJobInput, deps: ApplyJobDependencies = productionDependencies): ApplicationRun {
  const startedAt = Date.now(); const ledger = createRunLedger(); const requests = new Map<string, StoredAnswer>();
  const runId = deps.createRunId();
  let initialized = false; let paused = false; let closed = false; let terminal = false; let ready = false; let config: ReturnType<typeof getResolverModelConfig> | undefined;
  let activeAbort: AbortController | undefined; let activeTurn: Promise<void> | undefined;
  let runtime: ReturnType<typeof createApplyRuntime> | undefined; const trace: string[] = [];
  const answerStore: InteractiveAnswerStore = { resolve: (answerId) => {
    const answer = requests.get(answerId); return answer?.value === undefined ? undefined : { value: answer.value, identity: answer.identity, groupIdentity: answer.groupIdentity, kind: answer.kind };
  }};
  const interrupt = () => activeAbort?.abort();
  const close = async () => { if (closed) return; closed = true; interrupt(); await activeTurn?.catch(() => {}); await runtime?.browsers.close().catch(() => {}); };
  const blocked = (error: string, current?: PageState) => result("blocked", input.applicationUrl, startedAt, completedKeys(ledger), current ? requiredGaps(current.controls).map(label) : [], auditTrace(trace, ledger), error);
  const takeover = (reason: "authentication" | "human_verification"): ApplicationRunOutcome => {
    paused = true; ready = false;
    return { status: "needs_takeover", reason, instructions: reason === "authentication" ? "Complete the visible sign-in or verification step in the open browser, then resume." : "Complete the visible human-verification step in the open browser, then resume." };
  };
  const CAPTCHA_SOLVE_BUDGET_MS = 45_000;
  const CAPTCHA_SOLVE_POLL_MS = 15_000;
  const waitForCaptchaSolve = async (current: PageState): Promise<PageState> => {
    if (process.env.BROWSER_PROVIDER === "local") return current;
    trace.push("Challenge visible; giving Browserbase up to 45 seconds to solve it");
    const deadline = deps.now() + CAPTCHA_SOLVE_BUDGET_MS;
    let latest = current;
    while (deps.now() < deadline) {
      await deps.wait(Math.min(CAPTCHA_SOLVE_POLL_MS, deadline - deps.now()));
      try { latest = await deps.inspect(runtime!.browsers.actionBrowser, [], runId); } catch { break; }
      if (latest.intent !== "challenge") { trace.push("Challenge cleared; continuing"); return latest; }
    }
    return latest;
  };
  const initialize = async (): Promise<ApplicationResult | undefined> => {
    if (initialized) return; initialized = true;
    if (!isAllowedApplicationUrl(input.applicationUrl)) return blocked("applicationUrl must use HTTPS or loopback HTTP");
    if (unsafePromptIdentifier(input)) return blocked("Approved identifiers must use opaque dotted, hyphen, or underscore names");
    try { config = deps.getConfig(); } catch (error) { return blocked(safeError(error, collectEnvSecrets())); }
    trace.push(`Started general application agent with ${config.label}`);
    runtime = deps.createRuntime(config, input.catalog, input.credentials, ledger, answerStore);
    runtime.browsers.actionBrowser.setCurrentThread(runId);
    await runtime.browsers.actionBrowser.ensureReady();
    const manager = await runtime.browsers.actionBrowser.getManagerForThread(runId);
    await manager.getPage().goto(input.applicationUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  };
  const continuationPrompt = () => `Continue the current page without navigation. Approved interactive answer handles: ${[...requests.entries()].filter(([, answer]) => answer.value !== undefined).map(([requestId, answer]) => `${requestId} (${answer.label})`).join(", ") || "none"}. Use fill_interactive_answer with a fresh snapshot ref. Never submit.`;
  const streamAgent = async function* (prompt: string, signal: AbortSignal): AsyncGenerator<ApplicationEvent> {
    const active = runtime!; const id = runId;
    const agent = active.mastra.getAgentById("general-application-agent");
    yield { type: "status", status: "thinking", detail: "Mastra agent is working" };
    const output = await agent.stream(prompt, { runId: id, memory: { resource: input.applicationUrl, thread: id }, maxSteps: MAX_APPLY_STEPS, providerOptions: config!.agentProviderOptions, abortSignal: signal, prepareStep: ({ messages }) => ({ messages: compactSupersededSnapshots(messages) }) });
    for await (const chunk of output.fullStream) {
      if (chunk.type === "text-delta") yield { type: "text_delta", delta: chunk.payload.text };
      else if (chunk.type === "tool-call") yield { type: "tool", phase: "started", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName };
      else if (chunk.type === "tool-result") yield { type: "tool", phase: chunk.payload.isError ? "failed" : "completed", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName };
      else if (chunk.type === "tool-error") yield { type: "tool", phase: "failed", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName };
    }
  };
  const inspectAndAudit = async (inspected?: PageState): Promise<ApplicationRunOutcome> => {
    const seen = inspected ?? await deps.inspect(runtime!.browsers.actionBrowser, [], runId);
    const current = seen.intent === "challenge" ? await waitForCaptchaSolve(seen) : seen;
    if (current.intent === "challenge") return takeover("human_verification");
    if (current.intent === "authentication") return takeover("authentication");
    const gaps = requiredGaps(current.controls);
    if (gaps.length) { paused = true; ready = false; const output = gaps.map((control, index) => {
      const existing = [...requests.entries()].find(([, request]) => request.identity === control.identity && request.kind === control.kind && request.value === undefined);
      const requestId = existing?.[0] ?? `interactive.${index + 1}.${randomUUID()}`; requests.set(requestId, { identity: control.identity, groupIdentity: control.groupIdentity, kind: control.kind, fingerprint: current.fingerprint, label: label(control) });
      return { requestId, label: label(control), kind: control.kind, options: control.options.slice(0, 50).map((option) => boundedText(option, 160)) };
    }); return { status: "needs_input", requests: output }; }
    const audit = finalAudit(current, ledger.completed.length);
    if (!audit.ok) { terminal = true; return blocked(audit.error!, current); }
    const screenshotPath = await deps.screenshot(runtime!.browsers.actionBrowser, runId, "ready");
    if (!screenshotPath) { terminal = true; return blocked("Could not capture required pre-submit screenshot", current); }
    paused = false; ready = true; return result("ready_to_submit", input.applicationUrl, startedAt, completedKeys(ledger), [], auditTrace(trace, ledger, "Validated final submit boundary"), undefined, screenshotPath);
  };
  type Turn = { kind: "start" } | { kind: "message"; message: string } | { kind: "answers"; answers: InteractiveAnswer[] } | { kind: "takeover" };
  const streamTurn = async function* (turn: Turn): AsyncGenerator<ApplicationEvent> {
    if (closed || terminal) { yield { type: "outcome", outcome: blocked("Application run is closed or terminal") }; return; }
    if (activeTurn) { yield { type: "outcome", outcome: blocked("Application agent is already working") }; return; }
    const abort = new AbortController(); activeAbort = abort;
    let finishTurn!: () => void; activeTurn = new Promise<void>((resolve) => { finishTurn = resolve; });
    try {
      if (!initialized) yield { type: "session_started", threadId: runId };
      yield { type: "status", status: "starting", detail: initialized ? "Continuing application session" : "Opening application session" };
      const initial = await initialize(); if (initial) { terminal = true; yield { type: "outcome", outcome: initial }; return; }
      let prompt: string | undefined;
      if (turn.kind === "answers") {
        const current = await deps.inspect(runtime!.browsers.actionBrowser, [], runId);
        for (const answer of turn.answers) {
          const stored = requests.get(answer.requestId);
          if (!stored || stored.value !== undefined || stored.fingerprint !== current.fingerprint) { yield { type: "outcome", outcome: await inspectAndAudit(current) }; return; }
          stored.value = answer.value;
        }
        prompt = continuationPrompt();
      } else if (turn.kind === "message") {
        prompt = turn.message;
      } else {
        const seen = await deps.inspect(runtime!.browsers.actionBrowser, [], runId);
        const state = seen.intent === "challenge" ? await waitForCaptchaSolve(seen) : seen;
        if (state.intent === "challenge") { yield { type: "outcome", outcome: takeover("human_verification") }; return; }
        if (state.intent === "authentication" && !canAttemptInitialAuthentication(input.credentials)) { yield { type: "outcome", outcome: takeover("authentication") }; return; }
        if (turn.kind === "takeover" && paused && !requiredGaps(state.controls).length) { yield { type: "outcome", outcome: await inspectAndAudit(state) }; return; }
        prompt = turn.kind === "start" ? buildApplicationPrompt(input) : continuationPrompt();
      }
      for await (const event of streamAgent(prompt, abort.signal)) yield event;
      if (abort.signal.aborted) { yield { type: "interrupted" }; return; }
      yield { type: "status", status: "inspecting", detail: "Validating current application state" };
      yield { type: "outcome", outcome: await inspectAndAudit() };
    } catch (error) {
      if (abort.signal.aborted) yield { type: "interrupted" };
      else { terminal = true; yield { type: "outcome", outcome: blocked(safeError(error, [...collectEnvSecrets(), ...(config?.secrets ?? [])])) }; }
    } finally {
      activeAbort = undefined; activeTurn = undefined; finishTurn();
    }
  };
  const consumeOutcome = async (events: AsyncIterable<ApplicationEvent>): Promise<ApplicationRunOutcome> => {
    let outcome: ApplicationRunOutcome | undefined;
    for await (const event of events) if (event.type === "outcome") outcome = event.outcome;
    return outcome ?? blocked("Application run was interrupted");
  };
  const continueRun = async (answers: InteractiveAnswer[] = []): Promise<ApplicationRunOutcome> => {
    if (answers.length) return consumeOutcome(streamTurn({ kind: "answers", answers }));
    return consumeOutcome(streamTurn({ kind: initialized ? "takeover" : "start" }));
  };
  const submit = async (): Promise<ApplicationResult> => {
    if (closed || terminal || !ready || !runtime) return blocked("Application run is not ready to submit");
    ready = false;
    try {
      const before = await deps.inspect(runtime.browsers.actionBrowser, [], runId); const audit = finalAudit(before, ledger.completed.length);
      const screenshotPath = await deps.screenshot(runtime.browsers.actionBrowser, runId, audit.ok ? "ready" : "blocked");
      if (!audit.ok) { terminal = true; return blocked(audit.error!, before); }
      if (!screenshotPath) { terminal = true; return blocked("Could not capture required pre-submit screenshot", before); }
      if (!markSubmissionAttempted(ledger)) { terminal = true; return blocked("Submission was already attempted", before); }
      try { if (audit.final!.snapshotRef) await deps.clickRef(runtime.browsers.actionBrowser, audit.final!.snapshotRef, runId); else await deps.clickLabel(runtime.browsers.actionBrowser, audit.final!.label, runId); }
      catch { terminal = true; return result("blocked", input.applicationUrl, startedAt, completedKeys(ledger), [], auditTrace(trace, ledger, "Submission click attempted once"), "Submission outcome is uncertain; the click was not retried", screenshotPath); }
      try {
        let after = before;
        const confirmationDeadline = deps.now() + 15_000;
        while (true) {
          after = await deps.inspect(runtime.browsers.actionBrowser, [], runId);
          if (isBoundConfirmation(before, after)) break;
          const remaining = confirmationDeadline - deps.now();
          if (remaining <= 0) break;
          await deps.wait(Math.min(1_000, remaining));
        }
        const confirmed = isBoundConfirmation(before, after);
        const confirmationShot = await deps.screenshot(runtime.browsers.actionBrowser, runId, confirmed ? "submitted" : "submission-uncertain"); terminal = true;
        if (!confirmed) return result("blocked", input.applicationUrl, startedAt, completedKeys(ledger), [], auditTrace(trace, ledger, "Submission click attempted once"), "Submission outcome is uncertain; confirmation was not a bound same-origin page transition", confirmationShot ?? screenshotPath);
        return result("submitted", input.applicationUrl, startedAt, completedKeys(ledger), [], auditTrace(trace, ledger, "Verified visible submission confirmation"), undefined, confirmationShot ?? screenshotPath, after.applicationId);
      } catch { terminal = true; return result("blocked", input.applicationUrl, startedAt, completedKeys(ledger), [], auditTrace(trace, ledger, "Submission click attempted once"), "Submission outcome is uncertain; post-click inspection failed and was not retried", screenshotPath); }
    } catch (error) { terminal = true; return blocked(safeError(error, [...collectEnvSecrets(), ...(config?.secrets ?? [])])); }
  };
  return {
    startedAt,
    start: () => streamTurn({ kind: "start" }),
    sendMessage: (message) => streamTurn({ kind: "message", message }),
    provideAnswers: (answers) => streamTurn({ kind: "answers", answers }),
    resumeAfterTakeover: () => streamTurn({ kind: "takeover" }),
    interrupt,
    continue: continueRun,
    submit,
    close,
  };
}

/** General bounded controller. The one-shot entry point closes its run in all cases. */
export async function applyJob(input: ApplyJobInput): Promise<ApplicationResult> { return applyJobWithDependencies(input, productionDependencies); }
export async function applyJobWithDependencies(input: ApplyJobInput, deps: ApplyJobDependencies): Promise<ApplicationResult> {
  const run = createApplicationRun(input, deps);
  try { const outcome = await run.continue(); if (outcome.status === "needs_input" || outcome.status === "needs_takeover") return mapPausedOutcome(input.applicationUrl, outcome, run); return input.submit && outcome.status === "ready_to_submit" ? await run.submit() : outcome; }
  finally { await run.close(); }
}
function mapPausedOutcome(jobUrl: string, outcome: Extract<ApplicationRunOutcome, { status: "needs_input" | "needs_takeover" }>, run: ApplicationRun): ApplicationResult {
  // The run owns its start time; use its paused result mapping rather than a new clock.
  return outcome.status === "needs_input"
    ? result("blocked", jobUrl, run.startedAt, [], outcome.requests.map((item) => item.label), [], "Interactive input is required")
    : result("blocked", jobUrl, run.startedAt, [], [], [], outcome.instructions);
}
function boundedText(value: string, maxLength: number): string { return value.replace(/\s+/g, " ").trim().slice(0, maxLength); }
function label(control: PageControl): string { return boundedText(control.label, 240) || "Unlabelled required field"; }
function completedKeys(ledger: ReturnType<typeof createRunLedger>): string[] { return ledger.completed.map((item) => item.key); }
function auditTrace(trace: string[], ledger: ReturnType<typeof createRunLedger>, extra?: string): string[] { return [...new Set([...trace, ...ledger.completed.map((item) => `${item.source === "fact" ? "Completed field from approved fact" : item.source === "answer" ? "Completed field from approved reusable answer" : item.source === "resume" ? "Uploaded approved resume" : "Used approved credential"} ${item.key}`), ...(ledger.validatedFingerprints.length ? [`Validated ${ledger.validatedFingerprints.length} application step`] : []), ...(extra ? [extra] : [])])]; }
function result(status: ApplicationResult["status"], jobUrl: string, startedAt: number, fieldsCompleted: string[], missingRequired: string[], trace: string[], error?: string, screenshotPath?: string, applicationId?: string): ApplicationResult { return ApplicationResultSchema.parse({ status, jobUrl, fieldsCompleted: [...new Set(fieldsCompleted)], missingRequired: [...new Set(missingRequired)], runtimeMs: Date.now() - startedAt, trace, error, screenshotPath, screenshots: screenshotPath ? [screenshotPath] : undefined, applicationId }); }
