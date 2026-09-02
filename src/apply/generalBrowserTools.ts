import type { AgentBrowser } from "@mastra/agent-browser";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { isTrustedCapability, type CandidateFactCatalog, resolveFact, resolveReusableAnswer } from "./generalFacts.js";
import { exactOptionMatch, type PageControl } from "./pageState.js";
import { clickControlRef, fillControlRef, inspectControlRef, inspectCurrentPage, selectControlRef, selectCustomOptionRef, uploadControlRef, uploadUniqueFileInput } from "./pageInspection.js";
import { resolveApprovedResume } from "./resume.js";
import { isFinalControl } from "./generalSafety.js";
import { recordCompletion, recordTransition, recordValidatedStep, type ApplicationRunLedger } from "./runLedger.js";

export interface CredentialHandles {
  resolve(handle: string): string | undefined;
  /** Opaque names the agent may request; never credential values. */
  handles?: readonly string[];
}

/** Controller-owned values for one paused run. The agent can request only IDs. */
export interface InteractiveAnswerStore {
  resolve(answerId: string): { value: string; identity: string; groupIdentity?: string; kind: PageControl["kind"] } | undefined;
}

type SafeOutcome = { success: boolean; ref: string; factKey?: string; answerKey?: string; credentialHandle?: string; resumeId?: string; error?: string };

/** Fact-backed tools. Their outputs deliberately exclude candidate values and file paths. */
export function createGeneralApplicationTools(browser: AgentBrowser, catalog: CandidateFactCatalog, credentials: CredentialHandles = { resolve: () => undefined }, ledger?: ApplicationRunLedger, interactiveAnswers?: InteractiveAnswerStore) {
  const lookedUpFacts = new Set<string>();
  const disclosedCandidateValues = new Set<string>();
  const disclose = (source: "fact" | "answer", key: string) => {
    const id = `${source}:${key}`;
    if (disclosedCandidateValues.has(id)) return "Candidate value was already disclosed";
    if (disclosedCandidateValues.size >= 30) return "Candidate lookup budget is exhausted";
    disclosedCandidateValues.add(id);
  };
  const thread = (agent: { threadId?: string } | undefined) => {
    const threadId = agent?.threadId;
    // Test doubles may omit this AgentBrowser method; production AgentBrowser always binds it.
    if (typeof (browser as { setCurrentThread?: (id?: string) => void }).setCurrentThread === "function") browser.setCurrentThread(threadId);
    return threadId;
  };
  const mutate = async (ref: string, allowed: string[], action: (threadId?: string) => Promise<void>, metadata: Omit<SafeOutcome, "success" | "ref" | "error">, agent?: { threadId?: string }): Promise<SafeOutcome> => {
    const threadId = thread(agent);
    const control = await inspectControlRef(browser, ref, threadId);
    if (!control) return { success: false, ref, ...metadata, error: "Snapshot ref is stale or unknown" };
    if (!control.visible || !control.enabled || !allowed.includes(control.kind)) return { success: false, ref, ...metadata, error: `Control is not an enabled ${allowed.join(" or ")}` };
    try {
      await action(threadId);
      if (ledger) recordCompletion(ledger, { identity: control.identity, source: metadata.factKey ? "fact" : metadata.answerKey ? "answer" : metadata.resumeId ? "resume" : "credential", key: metadata.factKey ?? metadata.answerKey ?? metadata.resumeId ?? metadata.credentialHandle ?? "" });
      return { success: true, ref, ...metadata };
    } catch { return { success: false, ref, ...metadata, error: "Control mutation failed" }; }
  };
  const tools = {
    inspect_current_page: createTool({ id: "inspect_current_page", description: "Inspect visible main-document controls. Values and passwords are never returned.", inputSchema: z.object({ refs: z.array(z.string()).default([]) }), execute: async ({ refs }, { agent }) => inspectCurrentPage(browser, refs, thread(agent)) }),
    application_capabilities: createTool({ id: "application_capabilities", description: "Return the compact, value-free catalog manifest before mapping application fields.", inputSchema: z.object({}), execute: async () => ({
      factKeys: Object.keys(catalog.facts).filter((key) => isTrustedCapability("fact", key)),
      answerKeys: Object.keys(catalog.reusableAnswers).filter((key) => isTrustedCapability("answer", key)),
      hasApprovedResume: Boolean(catalog.approvedResumeId && isTrustedCapability("resume", catalog.approvedResumeId) && resolveApprovedResume(catalog.approvedResumeId).ok),
      approvedResumeId: catalog.approvedResumeId && isTrustedCapability("resume", catalog.approvedResumeId) && resolveApprovedResume(catalog.approvedResumeId).ok ? catalog.approvedResumeId : undefined,
      supportedActions: ["fill_fact", "select_fact", "choose_fact_option", "fill_reusable_answer", "fill_interactive_answer", "upload_approved_resume"],
      candidateSources: ["approved_candidate_facts", "approved_reusable_answers", "approved_resume"],
    }) }),
    candidate_get: createTool({ id: "candidate_get", description: "Retrieve up to 30 requested approved candidate facts and reusable answers in one call. Do not request values until form semantics require them.", inputSchema: z.object({ factKeys: z.array(z.string()).default([]), answerKeys: z.array(z.string()).default([]) }).refine(({ factKeys, answerKeys }) => factKeys.length + answerKeys.length <= 30, "At most 30 keys may be requested"), execute: async ({ factKeys, answerKeys }) => {
      const facts = factKeys.map((factKey) => {
        if (!isTrustedCapability("fact", factKey)) return { source: "fact", key: factKey, error: "Unapproved fact key" };
        const fact = resolveFact(catalog, factKey);
        if (!fact.ok) return { source: "fact", key: factKey, error: fact.error };
        const disclosureError = disclose("fact", factKey);
        if (disclosureError) return { source: "fact", key: factKey, error: disclosureError };
        lookedUpFacts.add(factKey);
        return { source: "fact", key: factKey, value: fact.value };
      });
      const answers = answerKeys.map((answerKey) => {
        if (!isTrustedCapability("answer", answerKey)) return { source: "answer", key: answerKey, error: "Unapproved reusable answer key" };
        const answer = resolveReusableAnswer(catalog, answerKey);
        if (!answer.ok) return { source: "answer", key: answerKey, error: answer.error };
        const disclosureError = disclose("answer", answerKey);
        return disclosureError ? { source: "answer", key: answerKey, error: disclosureError } : { source: "answer", key: answerKey, value: answer.value };
      });
      return { success: [...facts, ...answers].every((item) => !("error" in item)), values: [...facts, ...answers] };
    }}),
    lookup_candidate_fact: createTool({ id: "lookup_candidate_fact", description: "Retrieve one approved scalar candidate fact when semantic field comparison is needed.", inputSchema: z.object({ factKey: z.string() }), execute: async ({ factKey }) => {
      if (!isTrustedCapability("fact", factKey)) return { success: false, factKey, error: "Unapproved fact key" };
      const fact = resolveFact(catalog, factKey); if (!fact.ok) return { success: false, factKey, error: fact.error };
      const disclosureError = disclose("fact", factKey); if (disclosureError) return { success: false, factKey, error: disclosureError };
      lookedUpFacts.add(factKey); return { success: true, factKey, value: fact.value };
    }}),
    lookup_reusable_answer: createTool({ id: "lookup_reusable_answer", description: "Retrieve one approved reusable answer when its wording is needed.", inputSchema: z.object({ answerKey: z.string() }), execute: async ({ answerKey }) => {
      if (!isTrustedCapability("answer", answerKey)) return { success: false, answerKey, error: "Unapproved reusable answer key" };
      const answer = resolveReusableAnswer(catalog, answerKey); if (!answer.ok) return { success: false, answerKey, error: answer.error };
      const disclosureError = disclose("answer", answerKey); if (disclosureError) return { success: false, answerKey, error: disclosureError };
      return { success: true, answerKey, value: answer.value };
    }}),
    fill_fact: createTool({ id: "fill_fact", description: "Fill an enabled visible text control from an approved fact key.", inputSchema: z.object({ ref: z.string(), factKey: z.string() }), execute: async ({ ref, factKey }, { agent }) => {
      const fact = resolveFact(catalog, factKey); if (!fact.ok) return "key" in fact ? { success: false, ref, factKey, error: fact.error } : { success: false, ref, error: fact.error };
      if (typeof fact.value === "boolean") return { success: false, ref, factKey, error: "Boolean facts require choose_fact_option" };
      return mutate(ref, ["text", "textarea"], (threadId) => fillControlRef(browser, ref, String(fact.value), threadId), { factKey }, agent);
    }}),
    select_fact: createTool({ id: "select_fact", description: "Select an exact native or custom combobox option from an approved fact, or a model-selected visible label after lookup.", inputSchema: z.object({ ref: z.string(), factKey: z.string(), optionLabel: z.string().optional() }), execute: async ({ ref, factKey, optionLabel }, { agent }) => selectFact(browser, catalog, ref, factKey, false, thread(agent), ledger, lookedUpFacts.has(factKey) ? optionLabel : undefined) }),
    choose_fact_option: createTool({ id: "choose_fact_option", description: "Choose an exact visible radio, checkbox, or ARIA option from an approved fact; semantic mapping requires prior lookup.", inputSchema: z.object({ ref: z.string(), factKey: z.string() }), execute: async ({ ref, factKey }, { agent }) => selectFact(browser, catalog, ref, factKey, true, thread(agent), ledger, lookedUpFacts.has(factKey) ? "semantic" : undefined) }),
    fill_reusable_answer: createTool({ id: "fill_reusable_answer", description: "Fill an enabled visible text control from an approved reusable-answer key.", inputSchema: z.object({ ref: z.string(), answerKey: z.string() }), execute: async ({ ref, answerKey }, { agent }) => {
      const answer = resolveReusableAnswer(catalog, answerKey); if (!answer.ok) return "key" in answer ? { success: false, ref, answerKey, error: answer.error } : { success: false, ref, error: answer.error };
      return mutate(ref, ["text", "textarea"], (threadId) => fillControlRef(browser, ref, String(answer.value), threadId), { answerKey }, agent);
    }}),
    fill_interactive_answer: createTool({ id: "fill_interactive_answer", description: "Use one controller-approved interactive answer handle on its exact current-page field. Request a fresh snapshot ref first. Values are never returned.", inputSchema: z.object({ ref: z.string(), answerId: z.string() }), execute: async ({ ref, answerId }, { agent }) => {
      const answer = interactiveAnswers?.resolve(answerId);
      if (!answer) return { success: false, ref, answerId, error: "Interactive answer is unavailable or stale" };
      const threadId = thread(agent); const control = await inspectControlRef(browser, ref, threadId);
      if (!control) return { success: false, ref, answerId, error: "Interactive answer is not bound to this current control" };
      const sameControl = control.identity === answer.identity || (answer.identity.startsWith("radio-group:") && control.groupIdentity === answer.groupIdentity);
      if (!control.visible || !control.enabled || !sameControl || control.kind !== answer.kind || control.groupIdentity !== answer.groupIdentity) return { success: false, ref, answerId, error: "Interactive answer is not bound to this current control" };
      try {
        if (["text", "textarea"].includes(control.kind)) await fillControlRef(browser, ref, answer.value, threadId);
        else if (control.kind === "select") { const option = exactOptionMatch(control.options, answer.value); if (!option) return { success: false, ref, answerId, error: "No exact visible option matches the approved answer" }; await selectControlRef(browser, ref, option, threadId); }
        else if (["combobox", "listbox"].includes(control.kind)) await selectCustomOptionRef(browser, ref, answer.value, threadId);
        else if (["radio", "option"].includes(control.kind)) { if (!exactOptionMatch([control.label], answer.value)) return { success: false, ref, answerId, error: "Approved answer does not exactly match this option" }; await clickControlRef(browser, ref, threadId); }
        else if (control.kind === "checkbox") { const expected = booleanOptionLabel(answer.value); if (expected === undefined) return { success: false, ref, answerId, error: "Checkbox answer must be Yes or No" }; if (control.filled !== expected) await clickControlRef(browser, ref, threadId); }
        else return { success: false, ref, answerId, error: "Interactive answer cannot fill this control kind" };
        ledger && recordCompletion(ledger, { identity: control.identity, source: "answer", key: answerId });
        return { success: true, ref, answerId };
      } catch { return { success: false, ref, answerId, error: "Control mutation failed" }; }
    }}),
    fill_credential: createTool({ id: "fill_credential", description: "Fill an enabled visible text or password control using an approved opaque credential handle.", inputSchema: z.object({ ref: z.string(), credentialHandle: z.string() }), execute: async ({ ref, credentialHandle }, { agent }) => {
      if (!isTrustedCapability("credential", credentialHandle)) return { success: false, ref, error: "Approved credential handle is unavailable" };
      if (!credentials.handles?.includes(credentialHandle)) return { success: false, ref, error: "Approved credential handle is unavailable" };
      const value = credentials.resolve(credentialHandle); if (!value) return { success: false, ref, credentialHandle, error: "Approved credential handle is unavailable" };
      return mutate(ref, ["text", "textarea"], (threadId) => fillControlRef(browser, ref, value, threadId), { credentialHandle }, agent);
    }}),
    upload_approved_resume: createTool({ id: "upload_approved_resume", description: "Upload an approved resume through a referenced or unique native file input and return success only after the page confirms the attachment.", inputSchema: z.object({ ref: z.string().optional(), resumeId: z.string() }), execute: async ({ ref, resumeId }, { agent }) => {
      const outputRef = ref ?? "unique-file-input";
      if (!isTrustedCapability("resume", resumeId)) return { success: false, ref: outputRef, error: "Requested resume ID is unavailable. Use the exact ID from application_capabilities." };
      if (!catalog.approvedResumeId || resumeId !== catalog.approvedResumeId) return { success: false, ref, resumeId, error: "Requested resume is not the catalog-approved resume" };
      const resume = resolveApprovedResume(resumeId); if (!resume.ok) return { success: false, ref, resumeId, error: "Approved resume is unavailable" };
      const threadId = thread(agent);
      try {
        if (!ref) await uploadUniqueFileInput(browser, resume.filePath, threadId);
        else {
          const control = await inspectControlRef(browser, ref, threadId);
          if (!control || !control.enabled || control.kind !== "file") return { success: false, ref, resumeId, error: `Target is ${control?.kind ?? "unknown"}, not a file input. Use its associated native file input ref, or omit ref when exactly one file input exists.` };
          await uploadControlRef(browser, ref, resume.filePath, threadId);
        }
        ledger && recordCompletion(ledger, { identity: ref ?? "unique-file-input", source: "resume", key: resumeId });
        return { success: true, verified: true, ref: outputRef, resumeId };
      } catch (error) {
        return { success: false, ref: outputRef, resumeId, error: error instanceof Error ? error.message : "Upload failed" };
      }
    }}),
    click_reversible: createTool({ id: "click_reversible", description: "Click one enabled visible non-file, non-final control and report only state change metadata.", inputSchema: z.object({ ref: z.string() }), execute: async ({ ref }, { agent }) => {
      const threadId = thread(agent); const before = await inspectCurrentPage(browser, [], threadId); const control = await inspectControlRef(browser, ref, threadId);
      const reversible = control && (control.kind === "checkbox" || control.kind === "radio" || control.kind === "option" || (control.kind === "button" && control.progression === "previous"));
      if (!control || !control.visible || !control.enabled || !reversible || control.kind === "file" || control.progression === "final-submit" || isFinalControl(control)) return { success: false, ref, error: "Control is not a permitted reversible action" };
      if (ledger && ledger.latest?.action === `click:${control.identity}` && !ledger.latest.changed && ledger.latest.after === before.fingerprint && ledger.noProgressCount >= 1) return { success: false, ref, error: "Repeated no-progress reversible transition blocked" };
      try { await clickControlRef(browser, ref, threadId); const after = await inspectCurrentPage(browser, [], threadId); const changed = ledger ? recordTransition(ledger, `click:${control.identity}`, before.fingerprint, after.fingerprint) : before.fingerprint !== after.fingerprint; return { success: true, ref, changed }; } catch { return { success: false, ref, error: "Control mutation failed" }; }
    }}),
    advance_step: createTool({ id: "advance_step", description: "Advance through one enabled control labelled exactly Next only after visible required controls are complete.", inputSchema: z.object({ ref: z.string() }), execute: async ({ ref }, { agent }) => {
      const threadId = thread(agent); const before = await inspectCurrentPage(browser, [], threadId); const control = await inspectControlRef(browser, ref, threadId);
      if (before.unsupportedVisibleFrameCount) return { success: false, ref, error: "Visible embedded frame is unsupported" };
      if (!control || !control.visible || !control.enabled || control.progression !== "next") return { success: false, ref, error: "Control is not an unambiguous next-step action" };
      if (ledger && ledger.latest?.action === `advance:${control.identity}` && !ledger.latest.changed && ledger.latest.after === before.fingerprint && ledger.noProgressCount >= 1) return { success: false, ref, error: "Repeated no-progress step advance blocked" };
      const gaps = before.controls.filter((item) => item.visible && item.enabled && item.required && !item.filled); if (gaps.length) return { success: false, ref, error: "Visible required controls remain incomplete", missingRequired: gaps.map((item) => item.identity) };
      if (ledger) recordValidatedStep(ledger, before.fingerprint);
      try { await clickControlRef(browser, ref, threadId); const after = await inspectCurrentPage(browser, [], threadId); const changed = ledger ? recordTransition(ledger, `advance:${control.identity}`, before.fingerprint, after.fingerprint) : before.fingerprint !== after.fingerprint; return { success: true, ref, changed }; } catch { return { success: false, ref, error: "Control mutation failed" }; }
    }}),
    submit_authentication: createTool({ id: "submit_authentication", description: "Submit one structurally verified login form after approved credentials were filled.", inputSchema: z.object({ ref: z.string() }), execute: async ({ ref }, { agent }) => {
      const threadId = thread(agent); const before = await inspectCurrentPage(browser, [], threadId); const control = await inspectControlRef(browser, ref, threadId);
      const candidates = before.controls.filter((item) => item.visible && item.enabled && item.kind === "button" && /^(sign in|log in|login)$/i.test(item.label));
      if (before.intent !== "authentication" || before.authenticationMode !== "login" || before.unsupportedVisibleFrameCount || !ledger?.completed.some((item) => item.source === "credential") || candidates.length !== 1 || !control || control.identity !== candidates[0].identity) return { success: false, ref, error: "Authentication submission is not safely available" };
      if (before.controls.some((item) => item.visible && item.required && !item.filled)) return { success: false, ref, error: "Visible required controls remain incomplete" };
      if (ledger.latest?.action === `auth:${control.identity}` && !ledger.latest.changed && ledger.latest.after === before.fingerprint) return { success: false, ref, error: "Repeated no-progress authentication blocked" };
      try { await clickControlRef(browser, ref, threadId); const after = await inspectCurrentPage(browser, [], threadId); return { success: true, ref, changed: recordTransition(ledger, `auth:${control.identity}`, before.fingerprint, after.fingerprint) }; } catch { return { success: false, ref, error: "Authentication click outcome is uncertain" }; }
    }}),
  };
  return {
    ...tools,
    execute_application_actions: createTool({
      id: "execute_application_actions",
      description: "Preferred way to complete a page: execute up to 20 form actions (fact fills, selects, interactive answers, resume upload, checkbox/radio clicks) in one call. Batch every field you can already map instead of calling the individual tools one at a time. Set stopOnError=false for independent fields. Results never contain candidate values.",
      inputSchema: z.object({ actions: z.array(z.discriminatedUnion("action", [
        z.object({ action: z.literal("fill_fact"), ref: z.string(), factKey: z.string() }),
        z.object({ action: z.literal("select_fact"), ref: z.string(), factKey: z.string(), optionLabel: z.string().optional() }),
        z.object({ action: z.literal("choose_fact_option"), ref: z.string(), factKey: z.string() }),
        z.object({ action: z.literal("fill_reusable_answer"), ref: z.string(), answerKey: z.string() }),
        z.object({ action: z.literal("fill_interactive_answer"), ref: z.string(), answerId: z.string() }),
        z.object({ action: z.literal("upload_approved_resume"), ref: z.string().optional(), resumeId: z.string() }),
        z.object({ action: z.literal("click_reversible"), ref: z.string() }),
      ])).max(20), stopOnError: z.boolean().default(true).describe("Stop at the first failure. Set false for independent fields so one bad ref does not discard the rest.") }),
      execute: async ({ actions, stopOnError }, { agent }) => {
        const outcomes: Array<{ action: string; ref?: string; success: boolean; factKey?: string; answerKey?: string; answerId?: string; resumeId?: string; error?: string }> = [];
        for (const action of actions) {
          let result: SafeOutcome & { answerId?: string };
          if (action.action === "fill_fact") result = await tools.fill_fact.execute!(action, { agent } as never) as SafeOutcome;
          else if (action.action === "select_fact") result = await tools.select_fact.execute!(action, { agent } as never) as SafeOutcome;
          else if (action.action === "choose_fact_option") result = await tools.choose_fact_option.execute!(action, { agent } as never) as SafeOutcome;
          else if (action.action === "fill_reusable_answer") result = await tools.fill_reusable_answer.execute!(action, { agent } as never) as SafeOutcome;
          else if (action.action === "fill_interactive_answer") result = await tools.fill_interactive_answer.execute!(action, { agent } as never) as SafeOutcome & { answerId?: string };
          else if (action.action === "click_reversible") result = await tools.click_reversible.execute!(action, { agent } as never) as SafeOutcome;
          else result = await tools.upload_approved_resume.execute!(action, { agent } as never) as SafeOutcome;
          const { success, factKey, answerKey, resumeId, error } = result;
          outcomes.push({ action: action.action, ...(action.ref ? { ref: action.ref } : {}), success, ...(factKey ? { factKey } : {}), ...(answerKey ? { answerKey } : {}), ...(action.action === "fill_interactive_answer" ? { answerId: action.answerId } : {}), ...(resumeId ? { resumeId } : {}), ...(error ? { error } : {}) });
          if (!success && stopOnError) break;
        }
        return { success: outcomes.every((outcome) => outcome.success), outcomes };
      },
    }),
  };
}

async function selectFact(browser: AgentBrowser, catalog: CandidateFactCatalog, ref: string, factKey: string, choice: boolean, threadId?: string, ledger?: ApplicationRunLedger, semanticOption?: string): Promise<SafeOutcome> {
  const fact = resolveFact(catalog, factKey); if (!fact.ok) return "key" in fact ? { success: false, ref, factKey, error: fact.error } : { success: false, ref, error: fact.error };
  const control = await inspectControlRef(browser, ref, threadId);
  if (!control) return { success: false, ref, factKey, error: "Snapshot ref is stale or unknown" };
  if (!control.visible || !control.enabled) return { success: false, ref, factKey, error: "Control is not enabled and visible" };
  if (choice && typeof fact.value === "boolean") return setBooleanChoice(browser, ref, factKey, fact.value, control, threadId, ledger);
  const expected = String(fact.value);
  const option = exactOptionMatch(control.options, expected);
  if (control.kind === "select" && !choice) {
    const selected = semanticOption && semanticOption !== "semantic" ? exactOptionMatch(control.options, semanticOption) : option;
    if (!selected) return { success: false, ref, factKey, error: "No exact unambiguous option matches the approved fact" };
    try { await selectControlRef(browser, ref, selected, threadId); ledger && recordCompletion(ledger, { identity: control.identity, source: "fact", key: factKey }); return { success: true, ref, factKey }; } catch { return { success: false, ref, factKey, error: "Control mutation failed" }; }
  }
  if (["combobox", "listbox"].includes(control.kind) && !choice) {
    const selected = semanticOption && semanticOption !== "semantic" ? semanticOption : expected;
    try { await selectCustomOptionRef(browser, ref, selected, threadId); ledger && recordCompletion(ledger, { identity: control.identity, source: "fact", key: factKey }); return { success: true, ref, factKey }; } catch { return { success: false, ref, factKey, error: "No exact visible custom option matches the approved fact" }; }
  }
  if (choice && ["radio", "checkbox", "option"].includes(control.kind) && (exactOptionMatch([control.label], expected) || (semanticOption === "semantic" && typeof fact.value === "string" && ["radio", "option"].includes(control.kind)))) {
    try { await clickControlRef(browser, ref, threadId); ledger && recordCompletion(ledger, { identity: control.identity, source: "fact", key: factKey }); return { success: true, ref, factKey }; } catch { return { success: false, ref, factKey, error: "Control mutation failed" }; }
  }
  return { success: false, ref, factKey, error: "Control kind or exact option does not match the approved fact" };
}

async function setBooleanChoice(browser: AgentBrowser, ref: string, factKey: string, expected: boolean, control: PageControl, threadId?: string, ledger?: ApplicationRunLedger): Promise<SafeOutcome> {
  if (!control.visible || !control.enabled) return { success: false, ref, factKey, error: "Control is not enabled and visible" };
  if (control.kind === "checkbox") {
    if (control.filled === expected) { ledger && recordCompletion(ledger, { identity: control.identity, source: "fact", key: factKey }); return { success: true, ref, factKey }; }
    try { await clickControlRef(browser, ref, threadId); ledger && recordCompletion(ledger, { identity: control.identity, source: "fact", key: factKey }); return { success: true, ref, factKey }; } catch { return { success: false, ref, factKey, error: "Control mutation failed" }; }
  }
  if ((control.kind === "radio" || control.kind === "option") && booleanOptionLabel(control.label) === expected) {
    if (control.filled) { ledger && recordCompletion(ledger, { identity: control.identity, source: "fact", key: factKey }); return { success: true, ref, factKey }; }
    try { await clickControlRef(browser, ref, threadId); ledger && recordCompletion(ledger, { identity: control.identity, source: "fact", key: factKey }); return { success: true, ref, factKey }; } catch { return { success: false, ref, factKey, error: "Control mutation failed" }; }
  }
  return { success: false, ref, factKey, error: "Control does not represent the requested boolean choice" };
}

function booleanOptionLabel(label: string): boolean | undefined {
  const normalized = label.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (normalized === "yes" || normalized === "true") return true;
  if (normalized === "no" || normalized === "false") return false;
  return undefined;
}
