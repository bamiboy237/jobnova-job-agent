import { randomUUID } from "node:crypto";
import { compactSupersededSnapshots } from "../mastra/compactSnapshots.js";
import { getResolverModelConfig } from "../mastra/model.js";
import { collectEnvSecrets, safeError } from "../resolver/browserSafety.js";
import { candidateProfileToCatalog } from "../apply/candidateCatalog.js";
import { loadCandidateProfile } from "../apply/profile.js";
import { createRunLedger } from "../apply/runLedger.js";
import { createCareerRuntime, type CareerMode, type CareerRuntimeState } from "./careerAgent.js";

const MAX_CAREER_STEPS = 60;

export type CareerInteraction =
  | { kind: "user_input"; requestId: string; label: string; inputType: "text" | "date" | "email" | "tel" | "number" | "select" | "boolean"; description?: string; formatHint?: string; options: string[]; key: string }
  | { kind: "answer_approval"; requestId: string; label: string; draft: string; key: string }
  | { kind: "submission"; requestId: string; prompt: string; completedFields: number; screenshotPath: string };

export type CareerEvent =
  | { type: "session_started"; threadId: string }
  | { type: "status"; status: "thinking" | "resuming"; detail: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool"; phase: "started" | "completed" | "failed"; toolCallId: string; name: string }
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
  respond(input: string): AsyncIterable<CareerEvent>;
  status(): CareerSessionStatus;
  interrupt(): void;
  close(): Promise<void>;
}

export interface CareerSessionDependencies {
  getConfig: typeof getResolverModelConfig;
  loadProfile: typeof loadCandidateProfile;
  toCatalog: typeof candidateProfileToCatalog;
  createRuntime: typeof createCareerRuntime;
  createId: () => string;
}

const productionDependencies: CareerSessionDependencies = {
  getConfig: getResolverModelConfig,
  loadProfile: loadCandidateProfile,
  toCatalog: candidateProfileToCatalog,
  createRuntime: createCareerRuntime,
  createId: randomUUID,
};

type PendingInteraction = { runId: string; toolCallId: string; interaction: CareerInteraction };

function urlsIn(message: string): Set<string> {
  return new Set(message.match(/https?:\/\/[^\s"'`<>]+/gi)?.map((url) => url.replace(/[.,;)]+$/, "")) ?? []);
}

function isInteraction(value: unknown): value is CareerInteraction {
  if (!value || typeof value !== "object" || !("kind" in value) || !("requestId" in value)) return false;
  return value.kind === "user_input" || value.kind === "answer_approval" || value.kind === "submission";
}

export async function createCareerSession(deps: CareerSessionDependencies = productionDependencies): Promise<CareerSession> {
  const loaded = await deps.loadProfile();
  const config = deps.getConfig();
  const threadId = deps.createId();
  const state: CareerRuntimeState = {
    mode: "conversation",
    allowedUrls: new Set(),
    ledger: createRunLedger(),
    answers: new Map(),
    context: new Map(),
  };
  const catalog = loaded.ok ? deps.toCatalog(loaded.profile) : { facts: {}, reusableAnswers: {} };
  const runtime = deps.createRuntime(config, catalog, state, threadId);
  const agent = runtime.mastra.getAgentById("career-agent");
  let activeAbort: AbortController | undefined;
  let activeTurn: Promise<void> | undefined;
  let pending: PendingInteraction | undefined;
  let started = false;
  let closed = false;
  let resourcesClosed = false;

  const closeResources = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    await runtime.browsers.close().catch(() => {});
  };

  const streamOutput = async function* (output: Awaited<ReturnType<typeof agent.stream>>, runId: string, abort: AbortController): AsyncGenerator<CareerEvent> {
    for await (const chunk of output.fullStream) {
      if (chunk.type === "text-delta") yield { type: "text_delta", delta: chunk.payload.text };
      else if (chunk.type === "tool-call") yield { type: "tool", phase: "started", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName };
      else if (chunk.type === "tool-result") {
        const logicalFailure = chunk.payload.result && typeof chunk.payload.result === "object" && "success" in chunk.payload.result && chunk.payload.result.success === false;
        yield { type: "tool", phase: chunk.payload.isError || logicalFailure ? "failed" : "completed", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName };
      }
      else if (chunk.type === "tool-error") yield { type: "tool", phase: "failed", toolCallId: chunk.payload.toolCallId, name: chunk.payload.toolName };
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
    return runTurn((abort) => agent.stream(message, streamOptions(runId, abort)), runId, "thinking");
  };

  const respond = (input: string): AsyncIterable<CareerEvent> => {
    const suspended = pending;
    if (!suspended) return (async function* () { yield { type: "error", error: "The agent is not waiting for input" } as CareerEvent; })();
    pending = undefined;
    const normalized = input.trim().toLowerCase();
    let resumeData: { value: string } | { approved: boolean; value?: string } | { approved: boolean };
    if (suspended.interaction.kind === "user_input") resumeData = { value: input };
    else if (suspended.interaction.kind === "answer_approval") {
      if (normalized === "no") resumeData = { approved: false };
      else if (normalized === "yes") resumeData = { approved: true };
      else resumeData = { approved: true, value: input };
    } else resumeData = { approved: normalized === "yes" };
    return runTurn((abort) => agent.resumeStream(resumeData, { ...streamOptions(suspended.runId, abort), toolCallId: suspended.toolCallId }), suspended.runId, "resuming");
  };

  const interrupt = () => {
    activeAbort?.abort();
    if (pending) {
      agent.abortRunStream(pending.runId);
      pending = undefined;
    }
  };
  const close = async () => {
    if (closed && resourcesClosed) return;
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
    close,
  };
}
