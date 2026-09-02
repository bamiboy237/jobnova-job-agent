import { describe, expect, it } from "vitest";
import { canUseApplicationTool, canUseBrowserMutation, canUseStagehand, findControlByIdentity, secureInputMetadata } from "../src/career/careerAgent.js";
import { createCareerSession, parseCareerSessionState, serializeCareerSessionState, type CareerEvent, type CareerSessionDependencies } from "../src/career/careerSession.js";
import { createRunLedger, recordCompletion } from "../src/apply/runLedger.js";

function stream(chunks: unknown[]) {
  return { fullStream: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }) };
}

function setup() {
  let runtimeCreates = 0; let closes = 0; let interrupts = 0; const abortedRuns: string[] = [];
  const messages: string[] = []; const options: Array<{ runId: string; memory: { thread: string } }> = []; const resumes: unknown[] = [];
  let nextChunks: unknown[] = []; let nextError: Error | undefined;
  let capturedState: Parameters<CareerSessionDependencies["createRuntime"]>[2] | undefined;
  const agent = {
    stream: async (message: string, streamOptions: { runId: string; memory: { thread: string }; abortSignal: AbortSignal }) => {
      messages.push(message); options.push(streamOptions);
      streamOptions.abortSignal.addEventListener("abort", () => { interrupts += 1; }, { once: true });
      if (nextError) { const error = nextError; nextError = undefined; throw error; }
      const chunks = nextChunks; nextChunks = [];
      return stream(chunks);
    },
    resumeStream: async (data: unknown, streamOptions: { runId: string; memory: { thread: string }; abortSignal: AbortSignal }) => {
      resumes.push(data); options.push(streamOptions);
      return stream([{ type: "tool-result", payload: { toolCallId: "input-1", toolName: "request_user_input", isError: false, result: { success: true, answerId: "opaque" } } }]);
    },
    abortRunStream: (runId: string) => { abortedRuns.push(runId); return true; },
  };
  const deps = {
    getConfig: () => ({ agentModel: { id: "google/gemini-3.6-flash", apiKey: "key" }, browserModel: { modelName: "google/gemini-3.6-flash", apiKey: "key" }, label: "fake", secrets: ["key"] }),
    loadProfile: async () => ({ ok: true, profile: {} }),
    toCatalog: () => ({ facts: {}, reusableAnswers: {} }),
    createRuntime: (_config: unknown, _catalog: unknown, state: typeof capturedState) => { runtimeCreates += 1; capturedState = state; return { mastra: { getAgentById: () => agent }, browsers: { close: async () => { closes += 1; } } }; },
    createId: (() => { let id = 0; return () => `id-${++id}`; })(),
    loadSessionState: async () => { throw new Error("No saved test session"); },
    saveSessionState: async () => undefined,
  } as unknown as CareerSessionDependencies;
  return { deps, messages, options, resumes, abortedRuns, setChunks: (chunks: unknown[]) => { nextChunks = chunks; }, setError: (error: Error) => { nextError = error; }, counts: () => ({ runtimeCreates, closes, interrupts }), state: () => capturedState! };
}

async function collect(events: AsyncIterable<CareerEvent>): Promise<CareerEvent[]> {
  const result: CareerEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("conversational career session", () => {
  it("round-trips only value-free resumable session state", () => {
    const ledger = createRunLedger();
    recordCompletion(ledger, { identity: "id:email", source: "fact", key: "email" });
    const state = {
      mode: "applying", currentJobUrl: "https://jobs.example.test/apply",
      allowedUrls: new Set(["https://jobs.example.test/apply"]), ledger,
      answers: new Map([["answer", { value: "PRIVATE ANSWER" }]]),
      context: new Map([["email", { value: "SECRET VALUE" }]]),
    } as never;
    const serialized = JSON.stringify(serializeCareerSessionState("thread-1", state));
    expect(parseCareerSessionState(JSON.parse(serialized))).toEqual({
      threadId: "thread-1", mode: "applying", currentJobUrl: "https://jobs.example.test/apply",
      allowedUrls: ["https://jobs.example.test/apply"], completedLedgerKeys: ["email"],
    });
    expect(serialized).not.toContain("PRIVATE ANSWER");
    expect(serialized).not.toContain("SECRET VALUE");
  });

  it("uses one runtime and stable memory thread for normal conversation and sequential jobs", async () => {
    const fixture = setup();
    const session = await createCareerSession(fixture.deps);
    fixture.setChunks([{ type: "tool-result", payload: { toolCallId: "observe-1", toolName: "stagehand_observe", isError: false, result: { success: false, error: "Active page unavailable" } } }]);
    expect(await collect(session.sendMessage("hey"))).toContainEqual({ type: "tool", phase: "failed", toolCallId: "observe-1", name: "stagehand_observe", error: "Active page unavailable" });
    await collect(session.sendMessage("Apply to https://jobs.example.test/one"));
    await collect(session.sendMessage("Now inspect https://jobs.example.test/two"));
    expect(fixture.counts().runtimeCreates).toBe(1);
    expect(fixture.messages).toEqual(["hey", "Apply to https://jobs.example.test/one", "Now inspect https://jobs.example.test/two"]);
    expect(new Set(fixture.options.map((option) => option.memory.thread))).toEqual(new Set([session.threadId]));
    expect(fixture.state().allowedUrls).toEqual(new Set(["https://jobs.example.test/one", "https://jobs.example.test/two"]));
    await session.close();
  });

  it("normalizes native suspension and resumes private input without adding it to model messages or events", async () => {
    const fixture = setup();
    fixture.setChunks([{ type: "tool-call-suspended", payload: { toolCallId: "input-1", toolName: "request_user_input", args: { key: "education.graduation_date" }, resumeSchema: "{}", suspendPayload: { kind: "user_input", requestId: "input-1", label: "Graduation date", inputType: "date", options: [], key: "education.graduation_date" } } }]);
    const session = await createCareerSession(fixture.deps);
    const suspended = await collect(session.sendMessage("Continue the application"));
    const resumed = await collect(session.respond("2027-05-30"));
    expect(suspended).toContainEqual({ type: "interaction", interaction: { kind: "user_input", requestId: "input-1", label: "Graduation date", inputType: "date", options: [], key: "education.graduation_date" } });
    expect(fixture.resumes).toEqual([{ value: "2027-05-30" }]);
    expect(fixture.messages).toEqual(["Continue the application"]);
    expect(JSON.stringify([...suspended, ...resumed])).not.toContain("2027-05-30");
    await session.close();
  });

  it("collects multiple private fields in one suspension and resumes once without exposing values", async () => {
    const fixture = setup();
    fixture.setChunks([{ type: "tool-call-suspended", payload: {
      toolCallId: "inputs-1", toolName: "request_user_inputs", args: {}, resumeSchema: "{}",
      suspendPayload: { kind: "user_inputs", requestId: "inputs-1", fields: [
        { label: "Graduation date", inputType: "date", options: [], key: "education.graduation_date" },
        { label: "Sponsorship required", inputType: "boolean", options: ["Yes", "No"], key: "work.sponsorship" },
      ] },
    } }]);
    const session = await createCareerSession(fixture.deps);
    const suspended = await collect(session.sendMessage("Continue the application"));
    const invalid = await collect(session.respond("2027-05-30"));
    expect(invalid).toContainEqual({ type: "error", error: "All requested private values are required" });
    expect(session.status().waitingForInput).toBe(true);
    const resumed = await collect(session.respond(["2027-05-30", "No"]));
    expect(fixture.resumes).toEqual([{ values: ["2027-05-30", "No"] }]);
    expect(fixture.messages).toEqual(["Continue the application"]);
    expect(JSON.stringify([...suspended, ...invalid, ...resumed])).not.toContain("2027-05-30");
    await session.close();
  });

  it("allows resolver navigation only in resolution mode", () => {
    expect(canUseBrowserMutation("conversation", "browser_goto")).toBe(false);
    expect(canUseBrowserMutation("resolving", "browser_goto")).toBe(true);
    expect(canUseBrowserMutation("applying", "browser_click")).toBe(false);
    expect(canUseBrowserMutation("applying", "browser_tabs")).toBe(false);
    expect(canUseBrowserMutation("applying", "browser_snapshot")).toBe(true);
    expect(canUseBrowserMutation("applying", "browser_wait")).toBe(true);
    expect(canUseApplicationTool("resolving")).toBe(false);
    expect(canUseApplicationTool("applying")).toBe(true);
    expect(canUseStagehand("resolving")).toBe(true);
    expect(canUseStagehand("applying")).toBe(true);
    expect(canUseStagehand("applying", true)).toBe(false);
  });

  it("derives secure-input presentation from inspected control metadata", () => {
    const control = { kind: "select", label: "Graduation year", options: ["2026", "2027"] } as never;
    expect(secureInputMetadata(control, "select")).toEqual({ label: "Graduation year", inputType: "select", options: ["2026", "2027"] });
    expect(secureInputMetadata(control, "date")).toBeUndefined();
  });

  it("recovers a re-rendered interaction control by stable identity", () => {
    const previous = { identity: "form[0]/input[2]", snapshotRef: "@old" };
    const current = [
      { identity: "form[0]/input[1]", snapshotRef: "@other" },
      { identity: previous.identity, snapshotRef: "@fresh" },
    ];
    expect(findControlByIdentity(current as never, previous.identity)).toMatchObject({ snapshotRef: "@fresh" });
  });

  it("closes its one runtime exactly once", async () => {
    const fixture = setup();
    const session = await createCareerSession(fixture.deps);
    session.interrupt();
    await session.close();
    await session.close();
    expect(fixture.counts()).toMatchObject({ runtimeCreates: 1, closes: 1 });
  });

  it("cancels a suspended interaction without ending the conversation", async () => {
    const fixture = setup();
    fixture.setChunks([{ type: "tool-call-suspended", payload: { toolCallId: "input-1", toolName: "request_user_input", args: {}, resumeSchema: "{}", suspendPayload: { kind: "user_input", requestId: "input-1", label: "Graduation date", inputType: "date", options: [], key: "education.graduation_date" } } }]);
    const session = await createCareerSession(fixture.deps);
    await collect(session.sendMessage("Continue"));
    session.interrupt();
    expect(fixture.abortedRuns).toEqual(["id-2"]);
    expect(session.status().waitingForInput).toBe(false);
    await collect(session.sendMessage("Let's discuss the role instead"));
    expect(fixture.messages.at(-1)).toBe("Let's discuss the role instead");
    await session.close();
  });

  it("translates chat approval and exact submission confirmation into native resumes", async () => {
    const approval = setup();
    approval.setChunks([{ type: "tool-call-suspended", payload: { toolCallId: "approval-1", toolName: "request_answer_approval", args: {}, resumeSchema: "{}", suspendPayload: { kind: "answer_approval", requestId: "approval-1", label: "Why this company?", draft: "Draft answer", key: "responses.example.why" } } }]);
    const approvalSession = await createCareerSession(approval.deps);
    await collect(approvalSession.sendMessage("Draft the answer"));
    await collect(approvalSession.respond("My edited answer"));
    expect(approval.resumes).toEqual([{ approved: true, value: "My edited answer" }]);
    await approvalSession.close();

    const submission = setup();
    submission.setChunks([{ type: "tool-call-suspended", payload: { toolCallId: "submit-1", toolName: "request_submission", args: {}, resumeSchema: "{}", suspendPayload: { kind: "submission", requestId: "submit-1", prompt: "Submit?", completedFields: 12, screenshotPath: "/safe/ready.png" } } }]);
    const submissionSession = await createCareerSession(submission.deps);
    await collect(submissionSession.sendMessage("Apply"));
    await collect(submissionSession.respond("yes"));
    expect(submission.resumes).toEqual([{ approved: true }]);
    const repeated = await collect(submissionSession.respond("yes"));
    expect(repeated).toContainEqual({ type: "error", error: "The agent is not waiting for input" });
    await submissionSession.close();
  });

  it("closes browser resources when a career turn fails", async () => {
    const fixture = setup();
    fixture.setError(new Error("provider key failed"));
    const session = await createCareerSession(fixture.deps);
    const events = await collect(session.sendMessage("hey"));
    expect(events).toContainEqual({ type: "error", error: "provider *** failed" });
    expect(fixture.counts().closes).toBe(1);
    expect(await collect(session.sendMessage("try again"))).toContainEqual({ type: "error", error: "Career session is closed" });
    await session.close();
    expect(fixture.counts().closes).toBe(1);
  });
});
