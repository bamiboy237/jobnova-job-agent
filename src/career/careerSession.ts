import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { compactSupersededSnapshots } from "../mastra/compactSnapshots.js";
import { getResolverModelConfig } from "../mastra/model.js";
import { collectEnvSecrets, safeError } from "../resolver/browserSafety.js";
import { candidateProfileToCatalog } from "../apply/candidateCatalog.js";
import { inspectCurrentPage } from "../apply/pageInspection.js";
import { loadCandidateProfile } from "../apply/profile.js";
import { loadResumeFacts, resumesDir } from "../apply/resumeFacts.js";
import { resolveApprovedResume } from "../apply/resume.js";
import type { FactValue } from "../apply/generalFacts.js";
import { createRunLedger, type ApplicationRunLedger } from "../apply/runLedger.js";
import { createCareerRuntime, normalizeCandidateUrl, unwrapRedirectUrl, type CareerMode, type CareerRuntimeState } from "./careerAgent.js";

const MAX_CAREER_STEPS = 60;
export const CAREER_SESSION_PATH = path.resolve(process.cwd(), ".career-session.json");

export interface PersistedCareerSessionState {
  threadId: string;
  mode: CareerMode;
  currentJobUrl?: string;
  allowedUrls: string[];
  completedLedgerKeys: string[];
}

export interface CareerInputField {
  label: string;
  inputType: "text" | "date" | "email" | "tel" | "number" | "select" | "boolean";
  description?: string;
  formatHint?: string;
  options: string[];
  key: string;
}

export type CareerInteraction =
  | ({ kind: "user_input"; requestId: string } & CareerInputField)
  | { kind: "user_inputs"; requestId: string; fields: CareerInputField[] }
  | { kind: "answer_approval"; requestId: string; label: string; draft: string; key: string }
  | { kind: "submission"; requestId: string; prompt: string; completedFields: number; screenshotPath: string };

export type CareerEvent =
  | { type: "session_started"; threadId: string }
  | { type: "status"; status: "thinking" | "resuming"; detail: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool"; phase: "started" | "completed" | "failed"; toolCallId: string; name: string; error?: string }
  | { type: "interaction"; interaction: CareerInteraction }
  | { type: "error"; error: string }
  | { type: "interrupted" };

export interface CareerSessionStatus {
  threadId: string;
  mode: CareerMode;
  currentJobUrl?: string;
  working: boolean;
  waitingForInput: boolean;
}

export interface CareerSession {
  readonly threadId: string;
  sendMessage(message: string): AsyncIterable<CareerEvent>;
  respond(input: string | string[]): AsyncIterable<CareerEvent>;
  status(): CareerSessionStatus;
  interrupt(): void;
  releaseBrowser(): Promise<void>;
  close(): Promise<void>;
}

export interface CareerSessionDependencies {
  getConfig: typeof getResolverModelConfig;
  loadProfile: typeof loadCandidateProfile;
  toCatalog: typeof candidateProfileToCatalog;
  createRuntime: typeof createCareerRuntime;
  createId: () => string;
  loadSessionState: () => Promise<PersistedCareerSessionState>;
  saveSessionState: (state: PersistedCareerSessionState) => Promise<void>;
}

const productionDependencies: CareerSessionDependencies = {
  getConfig: getResolverModelConfig,
  loadProfile: loadCandidateProfile,
  toCatalog: candidateProfileToCatalog,
  createRuntime: createCareerRuntime,
  createId: randomUUID,
  loadSessionState: readCareerSessionState,
  saveSessionState: writeCareerSessionState,
};

type PendingInteraction = { runId: string; toolCallId: string; interaction: CareerInteraction };

export function serializeCareerSessionState(threadId: string, state: CareerRuntimeState): PersistedCareerSessionState {
  return {
    threadId,
    mode: state.mode,
    currentJobUrl: state.currentJobUrl,
    allowedUrls: [...state.allowedUrls],
    completedLedgerKeys: [...new Set(state.ledger.completed.map((item) => item.key))],
  };
}

export function parseCareerSessionState(value: unknown): PersistedCareerSessionState {
  if (!value || typeof value !== "object") throw new Error("Saved career session is invalid");
  const input = value as Record<string, unknown>;
  const modes: CareerMode[] = ["conversation", "resolving", "applying", "complete"];
  if (typeof input.threadId !== "string" || !modes.includes(input.mode as CareerMode)
    || !Array.isArray(input.allowedUrls) || !input.allowedUrls.every((url) => typeof url === "string")
    || !Array.isArray(input.completedLedgerKeys) || !input.completedLedgerKeys.every((key) => typeof key === "string")
    || (input.currentJobUrl !== undefined && typeof input.currentJobUrl !== "string")) {
    throw new Error("Saved career session is invalid");
  }
  return {
    threadId: input.threadId,
    mode: input.mode as CareerMode,
    currentJobUrl: input.currentJobUrl as string | undefined,
    allowedUrls: input.allowedUrls,
    completedLedgerKeys: input.completedLedgerKeys,
  };
}

async function readCareerSessionState(): Promise<PersistedCareerSessionState> {
  return parseCareerSessionState(JSON.parse(await fs.readFile(CAREER_SESSION_PATH, "utf8")));
}

async function writeCareerSessionState(state: PersistedCareerSessionState): Promise<void> {
  await fs.writeFile(CAREER_SESSION_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function urlsIn(message: string): Set<string> {
  const found = new Set<string>();
  for (const raw of message.match(/https?:\/\/[^\s"'`<>]+/gi) ?? []) {
    const cleaned = raw.replace(/[.,;)]+$/, "");
    for (const candidate of [cleaned, ...unwrapRedirectUrl(cleaned)]) {
      const normalized = normalizeCandidateUrl(candidate);
      if (normalized) found.add(normalized);
    }
  }
  return found;
}

function isInteraction(value: unknown): value is CareerInteraction {
  if (!value || typeof value !== "object" || !("kind" in value) || !("requestId" in value)) return false;
  return value.kind === "user_input" || value.kind === "user_inputs" || value.kind === "answer_approval" || value.kind === "submission";
}

export async function createCareerSession(deps: CareerSessionDependencies = productionDependencies, options: { resume?: boolean; persist?: boolean } = {}): Promise<CareerSession> {
  const loaded = await deps.loadProfile();
  const config = deps.getConfig();
  const saved = options.resume ? await deps.loadSessionState() : undefined;
  const threadId = saved?.threadId ?? deps.createId();
  const state: CareerRuntimeState = {
    mode: "conversation",
    allowedUrls: new Set(saved?.allowedUrls),
    ledger: createRunLedger(),
    answers: new Map(),
    context: new Map(),
  };
  const catalog = loaded.ok ? deps.toCatalog(loaded.profile) : { facts: {}, reusableAnswers: {} };
  const runtime = deps.createRuntime(config, catalog, state, threadId);
  const refreshResumeFacts = async (): Promise<void> => {
    const facts = await loadResumeFacts();
    const reloaded = await deps.loadProfile();
    const base = reloaded.ok ? deps.toCatalog(reloaded.profile) : { facts: {}, reusableAnswers: {} as Record<string, FactValue> };
    const writable = catalog.facts as Record<string, FactValue>;
    for (const key of Object.keys(writable)) delete writable[key];
    Object.assign(writable, facts, base.facts);
    (catalog as { approvedResumeId?: string }).approvedResumeId =
      base.approvedResumeId ?? (resolveApprovedResume("primary", resumesDir()).ok ? "primary" : undefined);
  };
  const runAfterRefresh = async function* (start: () => AsyncIterable<CareerEvent>): AsyncGenerator<CareerEvent> {
    await refreshResumeFacts();
    yield* start();
  };
  const agent = runtime.mastra.getAgentById("career-agent");
  if (saved) {
    runtime.browsers.actionBrowser.setCurrentThread(threadId);
    await runtime.browsers.actionBrowser.ensureReady();
    const page = await inspectCurrentPage(runtime.browsers.actionBrowser, [], threadId);
    state.currentJobUrl = page.url === "about:blank" ? undefined : page.url;
    state.mode = page.intent === "confirmation" ? "complete"
      : page.intent === "application" ? "applying"
        : state.currentJobUrl ? "resolving" : "conversation";
    state.ledger.completed = restoreCompletedLedger(saved.completedLedgerKeys);
  }
  let activeAbort: AbortController | undefined;
  let activeTurn: Promise<void> | undefined;
  let pending: PendingInteraction | undefined;
  let started = false;
  let closed = false;
  let browserReleased = false;

  const closeResources = async () => {
    if (browserReleased) return;
    browserReleased = true;
    await runtime.browsers.close().catch(() => {});
  };

  const restoreBrowser = async () => {
    if (!browserReleased) return;
    browserReleased = false;
    runtime.browsers.actionBrowser.setCurrentThread(threadId);
    await runtime.browsers.actionBrowser.ensureReady();
    if (!state.currentJobUrl) return;
    const manager = await runtime.browsers.actionBrowser.getManagerForThread(threadId);
    await manager.getPage().goto(state.currentJobUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  };

  const streamOutput = async function* (output: Awaited<ReturnType<typeof agent.stream>>, runId: string, abort: AbortController): AsyncGenerator<CareerEvent> {
    for await (const chunk of output.fullStream) {
      if (chunk.type === "text-delta") yield { type: "text_delta", delta: chunk.payload.text };
      else if (chunk.type === "tool-call") yield { type: "tool", phase: "started", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName };
      else if (chunk.type === "tool-result") {
        const result = chunk.payload.result;
        const logicalFailure = result && typeof result === "object" && "success" in result && result.success === false;
        const error = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : undefined;
        yield { type: "tool", phase: chunk.payload.isError || logicalFailure ? "failed" : "completed", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName, error };
      }
      else if (chunk.type === "tool-error") yield { type: "tool", phase: "failed", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName, error: safeError(chunk.payload.error, [...collectEnvSecrets(), ...config.secrets]) };
      else if (chunk.type === "tool-call-suspended" && isInteraction(chunk.payload.suspendPayload)) {
        pending = { runId, toolCallId: chunk.payload.toolCallId, interaction: chunk.payload.suspendPayload };
        yield { type: "interaction", interaction: chunk.payload.suspendPayload };
      }
    }
    if (abort.signal.aborted) yield { type: "interrupted" };
  };

  const runTurn = async function* (operation: (abort: AbortController) => Promise<Awaited<ReturnType<typeof agent.stream>>>, runId: string, status: "thinking" | "resuming"): AsyncGenerator<CareerEvent> {
    if (closed) { yield { type: "error", error: "Career session is closed" }; return; }
    if (activeTurn) { yield { type: "error", error: "Career agent is already working" }; return; }
    const abort = new AbortController();
    activeAbort = abort;
    let finish!: () => void;
    activeTurn = new Promise<void>((resolve) => { finish = resolve; });
    try {
      if (!started) { started = true; yield { type: "session_started", threadId }; }
      yield { type: "status", status, detail: status === "thinking" ? "Career agent is working" : "Career agent is continuing" };
      await restoreBrowser();
      const output = await operation(abort);
      yield* streamOutput(output, runId, abort);
    } catch (error) {
      if (abort.signal.aborted) yield { type: "interrupted" };
      else {
        closed = true;
        await closeResources();
        yield { type: "error", error: safeError(error, [...collectEnvSecrets(), ...config.secrets]) };
      }
    } finally {
      activeAbort = undefined;
      activeTurn = undefined;
      finish();
      if (options.persist !== false) await deps.saveSessionState(serializeCareerSessionState(threadId, state));
    }
  };

  const streamOptions = (runId: string, abort: AbortController) => ({
    runId,
    memory: { resource: threadId, thread: threadId },
    maxSteps: MAX_CAREER_STEPS,
    providerOptions: config.agentProviderOptions,
    abortSignal: abort.signal,
    prepareStep: ({ messages }: { messages: Parameters<typeof compactSupersededSnapshots>[0] }) => ({ messages: compactSupersededSnapshots(messages) }) as never,
  });

  const sendMessage = (message: string): AsyncIterable<CareerEvent> => {
    const runId = deps.createId();
    for (const url of urlsIn(message)) state.allowedUrls.add(url);
    return runAfterRefresh(() => runTurn((abort) => agent.stream(message, streamOptions(runId, abort)), runId, "thinking"));
  };

  const respond = (input: string | string[]): AsyncIterable<CareerEvent> => {
    const suspended = pending;
    if (!suspended) return (async function* () { yield { type: "error", error: "The agent is not waiting for input" } as CareerEvent; })();
    const expectsBatch = suspended.interaction.kind === "user_inputs";
    if (expectsBatch !== Array.isArray(input)) {
      return (async function* () { yield { type: "error", error: expectsBatch ? "All requested private values are required" : "This interaction accepts one response" } as CareerEvent; })();
    }
    pending = undefined;
    if (typeof input === "string") for (const url of urlsIn(input)) state.allowedUrls.add(url);
    const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
    let resumeData: { value: string } | { values: string[] } | { approved: boolean; value?: string } | { approved: boolean };
    if (suspended.interaction.kind === "user_input") resumeData = { value: input as string };
    else if (suspended.interaction.kind === "user_inputs") resumeData = { values: input as string[] };
    else if (suspended.interaction.kind === "answer_approval") {
      if (normalized === "no") resumeData = { approved: false };
      else if (normalized === "yes") resumeData = { approved: true };
      else resumeData = { approved: true, value: input as string };
    } else resumeData = { approved: normalized === "yes" };
    return runAfterRefresh(() => runTurn((abort) => agent.resumeStream(resumeData, { ...streamOptions(suspended.runId, abort), toolCallId: suspended.toolCallId }), suspended.runId, "resuming"));
  };

  const interrupt = () => {
    activeAbort?.abort();
    if (pending) {
      agent.abortRunStream(pending.runId);
      pending = undefined;
    }
  };
  const close = async () => {
    if (closed && browserReleased) return;
    closed = true;
    interrupt();
    await activeTurn?.catch(() => {});
    await closeResources();
  };

  return {
    threadId,
    sendMessage,
    respond,
    status: () => ({ threadId, mode: state.mode, currentJobUrl: state.currentJobUrl, working: Boolean(activeTurn), waitingForInput: Boolean(pending) }),
    interrupt,
    releaseBrowser: async () => {
      if (activeTurn) return;
      await closeResources();
    },
    close,
  };
}

export function resumeCareerSession(): Promise<CareerSession> {
  return createCareerSession(productionDependencies, { resume: true });
}

function restoreCompletedLedger(keys: string[]): ApplicationRunLedger["completed"] {
  return keys.map((key, index) => ({
    identity: `resumed:${index}`,
    source: key.startsWith("context.") ? "answer" as const : key === "primary" ? "resume" as const : "fact" as const,
    key,
  }));
}
