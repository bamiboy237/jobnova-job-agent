import { describe, expect, it } from "vitest";
import { AgentBrowser } from "@mastra/agent-browser";
import { LocalChromeSession } from "../src/browser/cdpSession.js";
import { createGeneralApplicationTools } from "../src/apply/generalBrowserTools.js";
import { resolveFact, resolveReusableAnswer, type CandidateFactCatalog } from "../src/apply/generalFacts.js";
import { inspectCurrentPage } from "../src/apply/pageInspection.js";
import { classifyControlIntent, classifyPageIntent, exactOptionMatch, fingerprintPage, isAllowedApplicationUrl, requiredGaps, type PageControl } from "../src/apply/pageState.js";

const catalog: CandidateFactCatalog = {
  facts: { "personal.name.full": "Taylor Sample", "authorization.sponsorship": false, "preferences.remote": true, "skills.primary": "Python" },
  reusableAnswers: { "application.cover_letter": "Approved reusable answer" },
  approvedResumeId: "primary",
};

const control = (partial: Partial<PageControl> = {}): PageControl => ({
  identity: "email", frame: "main", url: "https://example.test/apply", label: "Email", kind: "text",
  required: true, visible: true, enabled: true, filled: false, options: [], progression: "none", ...partial,
});

describe("general application Phase 1 pure boundaries", () => {
  it("allows HTTPS and only loopback HTTP application URLs", () => {
    expect(isAllowedApplicationUrl("https://careers.example.com/apply")).toBe(true);
    expect(isAllowedApplicationUrl("http://localhost:4173/apply")).toBe(true);
    expect(isAllowedApplicationUrl("http://127.0.0.1:4173/apply")).toBe(true);
    expect(isAllowedApplicationUrl("http://example.com/apply")).toBe(false);
    expect(isAllowedApplicationUrl("file:///tmp/form.html")).toBe(false);
  });

  it("resolves only approved scalar facts and reusable answers with explicit missing errors", () => {
    expect(resolveFact(catalog, "personal.name.full")).toMatchObject({ ok: true, value: "Taylor Sample" });
    expect(resolveFact(catalog, "work.current.title")).toEqual({ ok: false, error: "Unapproved fact key" });
    expect(resolveReusableAnswer(catalog, "application.cover_letter")).toMatchObject({ ok: true });
    expect(resolveReusableAnswer(catalog, "cover")).toMatchObject({ ok: false, error: "Missing approved fact: reusable.cover" });
  });

  it("requires one exact normalized option match", () => {
    expect(exactOptionMatch(["Python", "R"], " python ")).toBe("Python");
    expect(exactOptionMatch(["Yes", " yes "], true)).toBeUndefined();
    expect(exactOptionMatch(["Yes", " yes "], "yes")).toBeUndefined();
    expect(exactOptionMatch(["No"], "Yes")).toBeUndefined();
  });

  it("classifies visible gaps, control progression, page intent, and value-free fingerprints", () => {
    expect(requiredGaps([control(), control({ identity: "hidden", visible: false })]).map((item) => item.identity)).toEqual(["email"]);
    expect(classifyControlIntent("Continue", "button")).toBe("next");
    expect(classifyControlIntent("Submit application", "button")).toBe("final-submit");
    expect(classifyControlIntent("Submit my application", "button")).toBe("final-submit");
    expect(classifyPageIntent("https://example.test/login", "Sign in with password", [control({ kind: "text", credentialHint: "password" }), control({ kind: "button", label: "Sign in" })])).toBe("authentication");
    expect(classifyPageIntent("https://example.test/apply", "Already applied? Sign in", [control({ kind: "text", label: "Email" })])).toBe("application");
    expect(classifyPageIntent("https://example.test/apply", "Apply now. Sign up for job alerts.", [control({ kind: "text", label: "Email", credentialHint: "username" })])).toBe("application");
    expect(classifyPageIntent("https://example.test/verify", "Email verification", [control({ kind: "text", credentialHint: "verification" }), control({ kind: "button", label: "Continue" })])).toBe("authentication");
    expect(classifyPageIntent("https://example.test/apply", "Application protected by reCAPTCHA")).toBe("application");
    expect(classifyPageIntent("https://example.test/apply", "Application", [control({ kind: "button", label: "Verify you are human" })])).toBe("challenge");
    expect(classifyPageIntent("https://example.test/apply", "Application", [], true)).toBe("challenge");
    const first = fingerprintPage({ url: "https://example.test/apply", frame: "main", intent: "application", controls: [control()] });
    const second = fingerprintPage({ url: "https://example.test/apply", frame: "main", intent: "application", controls: [control()] });
    expect(first).toBe(second);
    expect(fingerprintPage({ url: "https://example.test/apply", frame: "main", intent: "application", controls: [control({ snapshotRef: "@old" })] }))
      .toBe(fingerprintPage({ url: "https://example.test/apply", frame: "main", intent: "application", controls: [control({ snapshotRef: "@new" })] }));
  });
});

describe("general protected tool boundaries", () => {
  it("rejects missing facts before resolving a browser locator", async () => {
    let managerCalls = 0;
    const browser = { getManagerForThread: async () => { managerCalls += 1; throw new Error("should not resolve locator"); } };
    const tools = createGeneralApplicationTools(browser as never, catalog);
    const result = await tools.fill_fact.execute({ ref: "@field", factKey: "personal.phone" }, {} as never);
    expect(result).toEqual({ success: false, ref: "@field", factKey: "personal.phone", error: "Missing approved fact: personal.phone" });
    expect(managerCalls).toBe(0);
  });

  it("sets boolean checkbox and Yes/No radio state idempotently", async () => {
    let clicks = 0;
    const page = { url: () => "http://localhost/fixture" };
    const browserFor = (state: PageControl) => {
      let current = state;
      return { getManagerForThread: async () => ({
      getPage: () => page,
      getLocatorFromRef: () => ({ evaluate: async () => current, click: async () => { clicks += 1; current = { ...current, filled: !current.filled }; } }),
    }) };
    };
    const checkbox = createGeneralApplicationTools(browserFor(control({ kind: "checkbox", filled: false })) as never, catalog);
    expect(await checkbox.choose_fact_option.execute({ ref: "@check", factKey: "authorization.sponsorship" }, {} as never)).toMatchObject({ success: true });
    expect(clicks).toBe(0); // false checkbox is already the requested state
    const yesRadio = createGeneralApplicationTools(browserFor(control({ kind: "radio", label: "Yes", filled: false })) as never, catalog);
    expect(await yesRadio.choose_fact_option.execute({ ref: "@yes", factKey: "authorization.sponsorship" }, {} as never)).toMatchObject({ success: false });
    expect(await yesRadio.choose_fact_option.execute({ ref: "@yes", factKey: "preferences.remote" }, {} as never)).toMatchObject({ success: true });
    expect(clicks).toBe(1);
    const noRadio = createGeneralApplicationTools(browserFor(control({ kind: "radio", label: "No", filled: true })) as never, catalog);
    expect(await noRadio.choose_fact_option.execute({ ref: "@no", factKey: "authorization.sponsorship" }, {} as never)).toMatchObject({ success: true });
    expect(clicks).toBe(1);
  });

  it("rejects a resume ID that differs from the catalog approval before filesystem access", async () => {
    const browser = { getManagerForThread: async () => { throw new Error("must not inspect"); } };
    const tools = createGeneralApplicationTools(browser as never, catalog);
    const result = await tools.upload_approved_resume.execute({ ref: "@file", resumeId: "other" }, {} as never);
    expect(result).toEqual({ success: false, ref: "@file", error: "Requested resume ID is unavailable. Use the exact ID from application_capabilities." });
  });

  it("fills text and boolean interactive answers only on their bound controls without returning values", async () => {
    let filled = "";
    const bound = control({ identity: "id:question", snapshotRef: "@bound" });
    const other = control({ identity: "id:other", snapshotRef: "@other" });
    const browser = { getManagerForThread: async () => ({ getPage: () => ({ url: () => "http://localhost/fixture" }), getLocatorFromRef: (ref: string) => ({ evaluate: async () => ref === "@bound" ? bound : other, fill: async (value: string) => { filled = value; } }) }) };
    const tools = createGeneralApplicationTools(browser as never, catalog, undefined, undefined, { resolve: (answerId) => answerId === "interactive.1" ? { value: "private answer", identity: "id:question", kind: "text" } : undefined });
    const result = await tools.fill_interactive_answer.execute({ ref: "@bound", answerId: "interactive.1" }, {} as never);
    expect(result).toEqual({ success: true, ref: "@bound", answerId: "interactive.1" });
    expect(filled).toBe("private answer");
    expect(JSON.stringify(result)).not.toContain("private answer");
    expect(await tools.fill_interactive_answer.execute({ ref: "@other", answerId: "interactive.1" }, {} as never)).toMatchObject({ success: false });

    let checked = false; let keyboardFallbacks = 0;
    const checkbox = control({ identity: "id:consent", kind: "checkbox", filled: false, snapshotRef: "@consent" });
    const checkboxBrowser = { getManagerForThread: async () => ({ getPage: () => ({ url: () => "http://localhost/fixture" }), getLocatorFromRef: () => ({
      evaluate: async () => ({ ...checkbox, filled: checked }),
      click: async () => { throw new Error("Link intercepted pointer"); },
      focus: async () => undefined,
      press: async (key: string) => { if (key === "Space") { checked = true; keyboardFallbacks += 1; } },
    }) }) };
    const checkboxTools = createGeneralApplicationTools(checkboxBrowser as never, catalog, undefined, undefined, { resolve: () => ({ value: "yes", identity: "id:consent", kind: "checkbox" }) });
    expect(await checkboxTools.fill_interactive_answer.execute({ ref: "@consent", answerId: "interactive.consent" }, {} as never)).toEqual({ success: true, ref: "@consent", answerId: "interactive.consent" });
    expect(checked).toBe(true);
    expect(keyboardFallbacks).toBe(1);
  });

  it("reveals only requested facts and requires lookup for semantic option mapping", async () => {
    let clicks = 0; let selected = "";
    const radio = control({ kind: "radio", label: "Eligible to work", identity: "id:work" });
    const select = control({ kind: "select", options: ["United States", "Canada"], identity: "id:country" });
    let radioFilled = false;
    const browser = { getManagerForThread: async () => ({ getPage: () => ({ url: () => "http://localhost/fixture" }), getLocatorFromRef: (ref: string) => ({ evaluate: async () => ref === "@radio" ? { ...radio, filled: radioFilled } : select, click: async () => { clicks += 1; radioFilled = true; }, selectOption: async ({ label }: { label: string }) => { selected = label; } }) }) };
    const tools = createGeneralApplicationTools(browser as never, { facts: { workAuthorization: "authorized", currentLocation: "US" }, reusableAnswers: {} });
    expect(await tools.choose_fact_option.execute({ ref: "@radio", factKey: "workAuthorization" }, {} as never)).toMatchObject({ success: false });
    expect(await tools.lookup_candidate_fact.execute({ factKey: "workAuthorization" }, {} as never)).toEqual({ success: true, factKey: "workAuthorization", value: "authorized" });
    expect(await tools.choose_fact_option.execute({ ref: "@radio", factKey: "workAuthorization" }, {} as never)).toMatchObject({ success: true });
    expect(clicks).toBe(1);
    expect(await tools.select_fact.execute({ ref: "@select", factKey: "currentLocation", optionLabel: "United States" }, {} as never)).toMatchObject({ success: false });
    await tools.candidate_get.execute({ factKeys: ["currentLocation"], answerKeys: [] }, {} as never);
    expect(await tools.lookup_candidate_fact.execute({ factKey: "currentLocation" }, {} as never)).toMatchObject({ success: false, error: "Candidate value was already disclosed" });
    expect(await tools.select_fact.execute({ ref: "@select", factKey: "currentLocation", optionLabel: "United States" }, {} as never)).toMatchObject({ success: true });
    expect(selected).toBe("United States");
  });

  it("returns a value-free capability manifest and only explicitly requested candidate values", async () => {
    const tools = createGeneralApplicationTools({} as never, catalog);
    const manifest = await tools.application_capabilities.execute({}, {} as never);
    expect(manifest).toMatchObject({ factKeys: expect.arrayContaining(["personal.name.full", "skills.primary"]), answerKeys: ["application.cover_letter"], supportedActions: expect.arrayContaining(["fill_fact", "upload_approved_resume"]) });
    expect(JSON.stringify(manifest)).not.toContain("Taylor Sample");
    expect(JSON.stringify(manifest)).not.toContain("Approved reusable answer");

    const result = await tools.candidate_get.execute({ factKeys: ["skills.primary"], answerKeys: [] }, {} as never);
    expect(result).toEqual({ success: true, values: [{ source: "fact", key: "skills.primary", value: "Python" }] });
    expect(JSON.stringify(result)).not.toContain("Taylor Sample");
    expect(JSON.stringify(result)).not.toContain("Approved reusable answer");
  });

  it("executes stable batch fills in order and returns value-free outcomes", async () => {
    const filled: string[] = [];
    const first = control({ identity: "first" });
    const second = control({ identity: "second" });
    const browser = { getManagerForThread: async () => ({ getPage: () => ({ url: () => "http://localhost/fixture" }), getLocatorFromRef: (ref: string) => ({ evaluate: async () => ref === "@first" ? first : second, fill: async (value: string) => { filled.push(`${ref}:${value}`); } }) }) };
    const tools = createGeneralApplicationTools(browser as never, { facts: { "personal.name.full": "Taylor Sample", "skills.primary": "Python" }, reusableAnswers: {} });
    const result = await tools.execute_application_actions.execute({ actions: [
      { action: "fill_fact", ref: "@first", factKey: "personal.name.full" },
      { action: "fill_fact", ref: "@second", factKey: "skills.primary" },
    ] }, {} as never);
    expect(filled).toEqual(["@first:Taylor Sample", "@second:Python"]);
    expect(result).toEqual({ success: true, outcomes: [
      { action: "fill_fact", success: true, factKey: "personal.name.full" },
      { action: "fill_fact", success: true, factKey: "skills.primary" },
    ] });
    expect(JSON.stringify(result)).not.toContain("Taylor Sample");
    expect(JSON.stringify(result)).not.toContain("Python");
  });

  it("stops a batch after the first failed action", async () => {
    const filled: string[] = [];
    const browser = { getManagerForThread: async () => ({ getPage: () => ({ url: () => "http://localhost/fixture" }), getLocatorFromRef: (ref: string) => ({ evaluate: async () => ref === "@bad" ? control({ enabled: false }) : control(), fill: async () => { filled.push(ref); } }) }) };
    const tools = createGeneralApplicationTools(browser as never, { facts: { "personal.name.full": "Taylor Sample", "skills.primary": "Python" }, reusableAnswers: {} });
    const result = await tools.execute_application_actions.execute({ actions: [
      { action: "fill_fact", ref: "@good", factKey: "personal.name.full" },
      { action: "fill_fact", ref: "@bad", factKey: "skills.primary" },
      { action: "fill_fact", ref: "@never", factKey: "personal.name.full" },
    ] }, {} as never);
    expect(filled).toEqual(["@good"]);
    expect(result).toMatchObject({ success: false, outcomes: [
      { success: true },
      { success: false },
    ] });
    expect(result.outcomes).toHaveLength(2);
  });
});

describe("local DOM fixture inspection", () => {
  it("inspects password state and semantic native/ARIA radio groups without leaking secrets", async () => {
    const session = new LocalChromeSession({ requireLinkedInAuth: false });
    const browser = new AgentBrowser({ cdpUrl: () => session.connect(), scope: "shared" });
    try {
      browser.setCurrentThread("inspection-test");
      await browser.ensureReady();
      const page = (await browser.getManagerForThread("inspection-test")).getPage();
      await page.setContent(`<!doctype html><body>
        <input id="first" aria-invalid="true" aria-errormessage="Candidate value must not escape" required>
        <input id="password" type="password">
        <fieldset><legend>Are you authorized to work?</legend>
          <input id="yes" type="radio" name="authorized" required><label for="yes">Yes</label>
          <input id="no" type="radio" name="authorized" checked><label for="no">No</label>
        </fieldset>
        <p id="remote-question">Will you work remotely?</p>
        <div id="remote-group" role="radiogroup" aria-labelledby="remote-question" aria-required="true">
          <div id="remote-yes" role="radio" aria-checked="true">Yes</div>
          <div id="remote-no" role="radio" aria-checked="false">No</div>
        </div>
        <div id="list" role="listbox"><div role="option" aria-selected="true">Remote</div></div>
        <input id="submit" type="submit" value="Submit Application">
      </body>`);
      await page.locator("#password").fill("actual-secret-password");
      const snapshot = await browser.snapshot({ interactiveOnly: true, maxDepth: 6 }, "inspection-test");
      const refs = [...snapshot.snapshot.matchAll(/@([a-z]\d+)/g)].map((match) => match[1]);
      const state = await inspectCurrentPage(browser, refs, "inspection-test");
      const nativeGroup = state.controls.find((item) => item.identity === "radio-group:native:authorized");
      expect(nativeGroup).toMatchObject({ label: "Are you authorized to work?", required: true, filled: true, options: ["Yes", "No"] });
      expect(nativeGroup?.optionRefs).toHaveLength(2);
      const ariaGroup = state.controls.find((item) => item.identity === "radio-group:aria:id:remote-group");
      expect(ariaGroup).toMatchObject({ label: "Will you work remotely?", required: true, filled: true, options: ["Yes", "No"] });
      expect(ariaGroup?.optionRefs).toHaveLength(2);
      expect(state.controls.find((item) => item.identity === "id:first")).toMatchObject({ snapshotRef: expect.any(String), validation: "invalid" });
      expect(JSON.stringify(state)).not.toContain("Candidate value must not escape");
      expect(state.controls.find((item) => item.identity === "id:password")).toMatchObject({ snapshotRef: expect.any(String), filled: true });
      expect(JSON.stringify(state)).not.toContain("actual-secret-password");
      expect(state.controls.find((item) => item.identity === "id:list")).toMatchObject({ kind: "listbox", filled: true });
      expect(state.controls.find((item) => item.identity === "id:submit")).toMatchObject({ label: "Submit Application", progression: "final-submit" });
    } finally { await browser.close(); await session.release(); }
  });
});
