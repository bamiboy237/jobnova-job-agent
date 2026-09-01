import { describe, expect, it } from "vitest";
import { finalAudit, isBoundConfirmation, isConfirmedApplication, uniqueFinalControl } from "../src/apply/generalSafety.js";
import { createRunLedger, markSubmissionAttempted, recordCompletion, recordTransition, recordValidatedStep } from "../src/apply/runLedger.js";
import { classifyControlIntent, extractApplicationId, type PageControl, type PageState } from "../src/apply/pageState.js";
import { applyJobWithDependencies, buildApplicationPrompt, createApplicationRun, isSafePromptIdentifier } from "../src/apply/applyJob.js";

const control = (partial: Partial<PageControl> = {}): PageControl => ({ identity: "email", frame: "main", url: "https://careers.example.test/apply", label: "Email", kind: "text", required: false, visible: true, enabled: true, filled: true, options: [], progression: "none", ...partial });
const state = (controls: PageControl[]): PageState => ({ url: "https://careers.example.test/apply", frame: "main", intent: "application", controls, fingerprint: "state" });

describe("general application Phase 2 safety", () => {
  it("keeps only safe run ledger evidence and bounds no-progress transitions", () => {
    const ledger = createRunLedger();
    recordCompletion(ledger, { identity: "id:email", source: "fact", key: "personal.email" });
    recordValidatedStep(ledger, "first"); recordValidatedStep(ledger, "first");
    expect(recordTransition(ledger, "click:id:next", "a", "a")).toBe(false);
    expect(recordTransition(ledger, "click:id:next", "a", "b")).toBe(true);
    expect(ledger).toMatchObject({ completed: [{ identity: "id:email", source: "fact", key: "personal.email" }], validatedFingerprints: ["first"], noProgressCount: 0 });
    expect(markSubmissionAttempted(ledger)).toBe(true);
    expect(markSubmissionAttempted(ledger)).toBe(false);
  });

  it("classifies broad final controls while keeping progression separate and blocks ambiguity", () => {
    for (const label of ["Submit", "Submit Application", "Submit My Application", "Complete Application", "Finish Application", "Send Application", "Apply Now"]) expect(classifyControlIntent(label, "button")).toBe("final-submit");
    expect(classifyControlIntent("Review and Submit", "button")).toBe("none");
    for (const label of ["Next", "Next Step", "Continue", "Save and Continue"]) expect(classifyControlIntent(label, "button")).toBe("next");
    for (const label of ["Review Application", "Apply", "Submit now", "Custom final phrase", "Open widget"]) expect(classifyControlIntent(label, "button")).toBe("none");
    const final = control({ identity: "submit", label: "Finish Application", kind: "button", progression: "final-submit" });
    expect(uniqueFinalControl(state([final]))).toBe(final);
    expect(finalAudit(state([control({ required: true, filled: false }), final]), 1)).toMatchObject({ ok: false, missingRequired: ["Email"] });
    expect(finalAudit(state([control(), final, control({ identity: "submit2", label: "Apply Now", kind: "button", progression: "final-submit" })]), 1)).toMatchObject({ ok: false });
  });

  it("accepts only visible confirmation intent or a verified success URL", () => {
    expect(isConfirmedApplication({ ...state([]), intent: "confirmation" })).toBe(true);
    expect(isConfirmedApplication({ ...state([]), url: "https://careers.example.test/submitted" })).toBe(true);
    expect(isConfirmedApplication(state([]))).toBe(false);
    expect(isBoundConfirmation(state([]), { ...state([]), url: "https://careers.example.test/submitted", intent: "confirmation" })).toBe(true);
    expect(isBoundConfirmation(state([]), { ...state([]), url: "https://evil.example/submitted", intent: "confirmation" })).toBe(false);
    expect(isBoundConfirmation(state([]), { ...state([]), intent: "confirmation" })).toBe(false);
    expect(isBoundConfirmation(state([]), { ...state([]), intent: "confirmation", fingerprint: "changed" })).toBe(true);
    expect(extractApplicationId("Application reference: ABC-123456")).toBe("ABC-123456");
  });

  it("builds a key-only controller prompt", () => {
    const prompt = buildApplicationPrompt({ applicationUrl: "https://careers.example.test/apply", catalog: { facts: { "personal.email": "candidate@example.test" }, reusableAnswers: { "application.cover_letter": "Approved answer" }, approvedResumeId: "primary" }, credentials: { handles: ["password"], resolve: () => "secret" } });
    expect(prompt).toBe("Complete the application at https://careers.example.test/apply. Approved fact keys: personal.email. Approved reusable-answer keys: application.cover_letter. Credential handles available: password. Approved resume id: primary. Never submit.");
  });

  it("accepts a trusted prompt identifier and rejects an unknown one", () => {
    expect(isSafePromptIdentifier("personal.email")).toBe(true);
    expect(isSafePromptIdentifier("personal.unknown")).toBe(false);
  });
});

describe("applyJob controller seam", () => {
  const finalState = (partial: Partial<PageState> = {}): PageState => ({ ...state([control({ identity: "submit", label: "Submit", kind: "button", progression: "final-submit", snapshotRef: "@submit" })]), ...partial });
  const input = (partial: Partial<Parameters<typeof applyJobWithDependencies>[0]> = {}) => ({ applicationUrl: "https://careers.example.test/apply", catalog: { facts: { "personal.email": "secret" }, reusableAnswers: {} }, ...partial });
  function fake(states: Array<PageState | Error>, options: { clickThrows?: boolean; closeThrows?: boolean; screenshotUndefined?: boolean; streamEvents?: unknown[]; waitForAbort?: boolean } = {}) {
    let generates = 0; let clicks = 0; let closeCalls = 0; let runtimeCreates = 0; const shots: string[] = []; const prompts: string[] = []; const threads: string[] = [];
    let clock = 0;
    const browser = { setCurrentThread: () => undefined, ensureReady: async () => undefined, getManagerForThread: async () => ({ getPage: () => ({ goto: async () => undefined }) }) };
    const deps = {
      getConfig: () => ({ agentModel: { id: "openai/gpt-5.6-luna", apiKey: "key" }, browserModel: { modelName: "openai/gpt-5.6-luna", apiKey: "key" }, label: "fake", secrets: ["key"] }),
      createRuntime: (_config: unknown, _catalog: unknown, _credentials: unknown, ledger: ReturnType<typeof createRunLedger>) => { runtimeCreates += 1; return { mastra: { getAgentById: () => ({ stream: async (prompt: string, streamOptions: { memory: { thread: string }; abortSignal: AbortSignal }) => { generates += 1; prompts.push(prompt); threads.push(streamOptions.memory.thread); recordCompletion(ledger, { identity: "id:email", source: "fact", key: "personal.email" }); return { fullStream: new ReadableStream({ start(controller) { for (const event of options.streamEvents ?? []) controller.enqueue(event); if (options.waitForAbort) streamOptions.abortSignal.addEventListener("abort", () => controller.close(), { once: true }); else controller.close(); } }) }; } }) }, browsers: { actionBrowser: browser, close: async () => { closeCalls += 1; if (options.closeThrows) throw new Error("close"); } } }; },
      inspect: async () => { const next = states.shift(); if (next instanceof Error) throw next; return next!; },
      screenshot: async (_browser: unknown, _thread: string, label: string) => { shots.push(label); return options.screenshotUndefined ? undefined : `/shot/${label}.png`; },
      clickRef: async () => { clicks += 1; if (options.clickThrows) throw new Error("click"); }, clickLabel: async () => { clicks += 1; }, createRunId: () => "run",
      now: () => clock,
      wait: async (milliseconds: number) => { clock += milliseconds; },
    };
    return { deps: deps as never, counts: () => ({ generates, clicks, closeCalls, runtimeCreates, shots }), prompts, threads };
  }
  it("keeps no-submit click-free and submits exactly once with bound SPA confirmation and ID", async () => {
    const ready = finalState(); const noSubmit = fake([ready, ready]); expect((await applyJobWithDependencies(input(), noSubmit.deps)).status).toBe("ready_to_submit"); expect(noSubmit.counts().clicks).toBe(0);
    const confirmed = { ...ready, intent: "confirmation" as const, fingerprint: "changed", applicationId: "APP-123456" };
    const submit = fake([ready, ready, ready, confirmed]); const result = await applyJobWithDependencies(input({ submit: true }), submit.deps); expect(result).toMatchObject({ status: "submitted", applicationId: "APP-123456" }); expect(submit.counts().clicks).toBe(1);
  });
  it("requires a pre-submit screenshot before either ready or submit outcomes", async () => {
    const ready = finalState();
    const noSubmit = fake([ready, ready], { screenshotUndefined: true });
    expect(await applyJobWithDependencies(input(), noSubmit.deps)).toMatchObject({ status: "blocked", error: "Could not capture required pre-submit screenshot" }); expect(noSubmit.counts().clicks).toBe(0);
    const submit = fake([ready, ready], { screenshotUndefined: true });
    expect(await applyJobWithDependencies(input({ submit: true }), submit.deps)).toMatchObject({ status: "blocked", error: "Could not capture required pre-submit screenshot" }); expect(submit.counts().clicks).toBe(0);
  });
  it("never retries click or post-click failures and ignores close failure", async () => {
    const ready = finalState(); const click = fake([ready, ready, ready], { clickThrows: true });
    expect((await applyJobWithDependencies(input({ submit: true }), click.deps)).status).toBe("blocked"); expect(click.counts().clicks).toBe(1);
    const inspect = fake([ready, ready, ready, new Error("inspect")]);
    expect((await applyJobWithDependencies(input({ submit: true }), inspect.deps)).status).toBe("blocked"); expect(inspect.counts().clicks).toBe(1);
    const unrelated = fake([ready, ready, ready, { ...ready, url: "https://evil.example/success", intent: "confirmation", fingerprint: "changed" }]);
    expect((await applyJobWithDependencies(input({ submit: true }), unrelated.deps)).status).toBe("blocked"); expect(unrelated.counts().clicks).toBe(1);
    const close = fake([ready, ready, ready, { ...ready, intent: "confirmation", fingerprint: "changed" }], { closeThrows: true });
    expect((await applyJobWithDependencies(input({ submit: true }), close.deps)).status).toBe("submitted"); expect(close.counts().closeCalls).toBe(1);
  });
  it("blocks unsafe identifiers before config or runtime creation", async () => {
    const f = fake([]); const result = await applyJobWithDependencies(input({ catalog: { facts: { "bad value": "x" }, reusableAnswers: {} } }), f.deps); expect(result.status).toBe("blocked"); expect(f.counts().generates).toBe(0);
  });

  it("pauses for required interactive input without closing, rejects unknown IDs, and closes once", async () => {
    const missing = state([control({ required: true, filled: false, snapshotRef: "@email" })]);
    const f = fake([missing, missing, missing]);
    const run = createApplicationRun(input(), f.deps);
    const paused = await run.continue();
    expect(paused.status).toBe("needs_input");
    expect(f.counts().closeCalls).toBe(0);
    expect(await run.continue([{ requestId: "unknown", value: "secret answer" }])).toMatchObject({ status: "needs_input" });
    expect(f.counts().generates).toBe(1);
    await run.close(); await run.close();
    expect(f.counts().closeCalls).toBe(1);
  });

  it("bounds interactive questions before returning them", async () => {
    const missing = state([control({ label: `Question ${"x".repeat(400)}`, required: true, filled: false, options: Array.from({ length: 80 }, (_, index) => `${index}-${"y".repeat(200)}`) })]);
    const f = fake([missing, missing]);
    const outcome = await createApplicationRun(input(), f.deps).continue();
    expect(outcome.status).toBe("needs_input");
    if (outcome.status !== "needs_input") return;
    expect(outcome.requests[0].label.length).toBe(240);
    expect(outcome.requests[0].options).toHaveLength(50);
    expect(outcome.requests[0].options.every((option) => option.length <= 160)).toBe(true);
  });

  it("keeps the same browser open for manual takeover and resumes without another agent turn", async () => {
    const application = state([]);
    const challenge = { ...state([]), intent: "challenge" as const };
    const ready = finalState();
    const f = fake([application, challenge, ready]);
    const run = createApplicationRun(input(), f.deps);
    expect(await run.continue()).toMatchObject({ status: "needs_takeover", reason: "human_verification" });
    expect(f.counts()).toMatchObject({ generates: 1, closeCalls: 0 });
    expect(await run.continue()).toMatchObject({ status: "ready_to_submit" });
    expect(f.counts()).toMatchObject({ generates: 1, closeCalls: 0 });
    await run.close();
    expect(f.counts().closeCalls).toBe(1);
  });

  it("streams ordinary messages and sanitized tool events on one runtime and thread", async () => {
    const ready = finalState();
    const streamEvents = [
      { type: "text-delta", runId: "run", from: "AGENT", payload: { id: "text-1", text: "Checking the form." } },
      { type: "tool-call", runId: "run", from: "AGENT", payload: { toolCallId: "tool-1", toolName: "inspect_current_page", args: { private: "not exposed" } } },
      { type: "tool-result", runId: "run", from: "AGENT", payload: { toolCallId: "tool-1", toolName: "inspect_current_page", result: { private: "not exposed" } } },
    ];
    const f = fake([ready, ready, ready], { streamEvents });
    const run = createApplicationRun(input(), f.deps);
    const first = []; for await (const event of run.start()) first.push(event);
    const second = []; for await (const event of run.sendMessage("What is blocking this application?")) second.push(event);
    expect(f.counts()).toMatchObject({ runtimeCreates: 1, generates: 2 });
    expect(f.threads).toEqual(["run", "run"]);
    expect(f.prompts[1]).toBe("What is blocking this application?");
    expect(second).toContainEqual({ type: "text_delta", delta: "Checking the form." });
    expect(second).toContainEqual({ type: "tool", phase: "started", toolCallId: "tool-1", name: "inspect_current_page" });
    expect(JSON.stringify(second)).not.toContain("not exposed");
    await run.close();
  });

  it("interrupts an active stream before closing browser resources", async () => {
    const ready = finalState();
    const f = fake([ready], { waitForAbort: true });
    const run = createApplicationRun(input(), f.deps);
    const events: unknown[] = [];
    const consuming = (async () => { for await (const event of run.start()) events.push(event); })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await run.close();
    await consuming;
    expect(events).toContainEqual({ type: "interrupted" });
    expect(f.counts()).toMatchObject({ runtimeCreates: 1, closeCalls: 1 });
  });
});
