import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import { applyJobWithDependencies } from "../src/apply/applyJob.js";
import { createGeneralApplicationTools } from "../src/apply/generalBrowserTools.js";
import { inspectCurrentPage } from "../src/apply/pageInspection.js";
import { createRunLedger } from "../src/apply/runLedger.js";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const canRun = Boolean(await import("node:fs").then((fs) => fs.existsSync(chrome)));
const test = canRun ? it : it.skip;

describe("local application fixtures", () => {
  test("inspects generic controls, conditional state, and exact Next", async () => {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<div id=step1><label>Email <input id=email required></label><label><input id=choice type=checkbox> Add detail</label><input id=detail required style="display:none"><button id=next onclick="step1.hidden=true;step2.hidden=false">Next</button><button>Continue</button><button>Review Application</button><button id=unknown>Open widget</button></div><div id=step2 hidden><label>Phone <input id=phone required></label></div><script>choice.onchange=()=>detail.style.display=choice.checked?'block':'none';</script>`);
      const refs = new Map([["@email", page.locator("#email")], ["@choice", page.locator("#choice")], ["@detail", page.locator("#detail")], ["@next", page.locator("#next")], ["@unknown", page.locator("#unknown")]]);
      const adapter = { setCurrentThread: () => undefined, getManagerForThread: async () => ({ getPage: () => page, getLocatorFromRef: (ref: string) => refs.get(ref) }) };
      const before = await inspectCurrentPage(adapter as never, [...refs.keys()]);
      expect(before.controls.some((item) => item.label === "Continue" && item.progression === "next")).toBe(true);
      const tools = createGeneralApplicationTools(adapter as never, { facts: { "preferences.remote": true, "personal.email": "fixture@example.test" }, reusableAnswers: {} });
      await tools.fill_fact.execute({ ref: "@email", factKey: "personal.email" }, { agent: { threadId: "t" } } as never);
      await tools.choose_fact_option.execute({ ref: "@choice", factKey: "preferences.remote" }, { agent: { threadId: "t" } } as never);
      expect((await inspectCurrentPage(adapter as never, [...refs.keys()])).controls.find((item) => item.identity === "id:detail")?.visible).toBe(true);
      expect(await tools.advance_step.execute({ ref: "@next" }, { agent: { threadId: "t" } } as never)).toMatchObject({ success: false, error: "Visible required controls remain incomplete" });
      expect(await tools.fill_fact.execute({ ref: "@detail", factKey: "personal.phone" }, { agent: { threadId: "t" } } as never)).toMatchObject({ success: false });
      const recovery = createGeneralApplicationTools(adapter as never, { facts: { "preferences.remote": true, "personal.email": "fixture@example.test", "personal.phone": "555" }, reusableAnswers: {} });
      await recovery.fill_fact.execute({ ref: "@detail", factKey: "personal.phone" }, { agent: { threadId: "t" } } as never);
      expect(await recovery.advance_step.execute({ ref: "@next" }, { agent: { threadId: "t" } } as never)).toMatchObject({ success: true });
      expect((await inspectCurrentPage(adapter as never)).controls.some((item) => item.label === "Phone")).toBe(true);
      expect(await recovery.click_reversible.execute({ ref: "@unknown" }, { agent: { threadId: "t" } } as never)).toMatchObject({ success: false });
    } finally { await browser.close(); }
  }, 15_000);

  test("runs no-submit and one-click same-URL confirmation through the controller", async () => {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const run = async (submit: boolean, ambiguous = false) => {
        const page = await browser.newPage(); let clicks = 0;
        await page.setContent(`<label>Email <input id=email required></label><button id=submit type=button onclick="window.__clicked=(window.__clicked||0)+1;document.body.innerHTML='Thank you for applying. Application reference: APP-123456'">Submit</button>${ambiguous ? '<button>Apply Now</button>' : ''}`);
        const refs = new Map([["@email", page.locator("#email")]]);
        const pageBridge = { goto: async () => undefined, locator: page.locator.bind(page), url: page.url.bind(page) };
        const adapter = { setCurrentThread: () => undefined, ensureReady: async () => undefined, getManagerForThread: async () => ({ getPage: () => pageBridge, getLocatorFromRef: (ref: string) => refs.get(ref) }) };
        const deps = {
          getConfig: () => ({ agentModel: { id: "openai/gpt-5.6-luna", apiKey: "x" }, browserModel: { modelName: "openai/gpt-5.6-luna", apiKey: "x" }, label: "fixture", secrets: [] }),
          createRuntime: (_a: unknown, _b: unknown, _c: unknown, ledger: ReturnType<typeof createRunLedger>) => ({ mastra: { getAgentById: () => ({ stream: async () => { const tools = createGeneralApplicationTools(adapter as never, { facts: { "personal.email": "fixture@example.test" }, reusableAnswers: {} }, undefined, ledger); await tools.fill_fact.execute({ ref: "@email", factKey: "personal.email" }, { agent: { threadId: "run" } } as never); return { fullStream: new ReadableStream({ start(controller) { controller.close(); } }) }; } }) }, browsers: { actionBrowser: adapter, close: async () => undefined } }),
          inspect: inspectCurrentPage, screenshot: async () => "/fixture/shot.png", clickRef: async () => undefined, clickLabel: async () => { clicks += 1; await page.locator("#submit").click(); }, createRunId: () => "run",
          now: Date.now, wait: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        };
        const result = await applyJobWithDependencies({ applicationUrl: "http://localhost/fixture", catalog: { facts: { "personal.email": "fixture@example.test" }, reusableAnswers: {} }, submit }, deps as never);
        return { result, clicks };
      };
      expect((await run(false)).result.status).toBe("ready_to_submit");
      const submitted = await run(true); expect(submitted.result).toMatchObject({ status: "submitted", applicationId: "APP-123456" }); expect(submitted.clicks).toBe(1);
      const blocked = await run(true, true); expect(blocked.result.status).toBe("blocked"); expect(blocked.clicks).toBe(0);
    } finally { await browser.close(); }
  });

  test("fills declared credentials without exposing secrets or clicking unsafe buttons", async () => {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage(); await page.setContent(`<input id=user><input id=password type=password><button id=submit onclick="window.n=(window.n||0)+1">Submit</button><button id=odd onclick="window.n=(window.n||0)+1">Do Thing</button>`);
      const refs = new Map([["@user", page.locator("#user")], ["@password", page.locator("#password")], ["@submit", page.locator("#submit")], ["@odd", page.locator("#odd")]]);
      const adapter = { setCurrentThread: () => undefined, getManagerForThread: async () => ({ getPage: () => page, getLocatorFromRef: (ref: string) => refs.get(ref) }) };
      let calls = 0; const tools = createGeneralApplicationTools(adapter as never, { facts: {}, reusableAnswers: {} }, { handles: ["username", "password"], resolve: (id) => { calls += 1; return id === "username" ? "SECRET-USER" : "SECRET-PASS"; } });
      const a = await tools.fill_credential.execute({ ref: "@user", credentialHandle: "username" }, { agent: { threadId: "t" } } as never); const b = await tools.fill_credential.execute({ ref: "@password", credentialHandle: "password" }, { agent: { threadId: "t" } } as never);
      expect(a).toEqual({ success: true, ref: "@user", credentialHandle: "username" }); expect(b).toEqual({ success: true, ref: "@password", credentialHandle: "password" }); expect((await inspectCurrentPage(adapter as never)).controls.filter((x) => x.filled).length).toBeGreaterThanOrEqual(2);
      expect(await tools.fill_credential.execute({ ref: "@user", credentialHandle: "ats-password" }, {} as never)).toMatchObject({ success: false }); expect(calls).toBe(2);
      expect(await tools.click_reversible.execute({ ref: "@submit" }, {} as never)).toMatchObject({ success: false }); expect(await tools.click_reversible.execute({ ref: "@odd" }, {} as never)).toMatchObject({ success: false }); expect(await page.evaluate(() => (window as any).n || 0)).toBe(0);
    } finally { await browser.close(); }
  });

  test("reports substantive visible frames while ignoring tiny hidden frames", async () => {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage(); await page.setContent(`<button id=next>Next</button><iframe id=big style="width:300px;height:150px"></iframe><iframe style="width:300px;height:150px;visibility:hidden"></iframe><iframe style="width:1px;height:1px;display:none"></iframe>`);
      const adapter = { getManagerForThread: async () => ({ getPage: () => page, getLocatorFromRef: (ref: string) => ref === "@next" ? page.locator("#next") : undefined }) };
      const state = await inspectCurrentPage(adapter as never);
      expect(state.unsupportedVisibleFrameCount).toBe(1);
      expect((await import("../src/apply/generalSafety.js")).finalAudit({ ...state, controls: [{ identity: "done", frame: "main", url: page.url(), label: "Submit", kind: "button", required: false, visible: true, enabled: true, filled: true, options: [], progression: "final-submit" }] }, 1)).toMatchObject({ ok: false, error: expect.stringContaining("frame") });
      const tools = createGeneralApplicationTools(adapter as never, { facts: {}, reusableAnswers: {} });
      expect(await tools.advance_step.execute({ ref: "@next" }, {} as never)).toMatchObject({ success: false, error: "Visible embedded frame is unsupported" });
    } finally { await browser.close(); }
  });

  test("authenticates through real local controls without leaking credentials or submitting", async () => {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<input id=user required autocomplete=username><input id=password required type=password><button id=signin onclick="window.loginClicks=(window.loginClicks||0)+1;document.body.innerHTML='<label>Email <input id=email required></label><button>Submit</button>'">Sign in</button>`);
      const refs = new Map([["@user", page.locator("#user")], ["@password", page.locator("#password")], ["@signin", page.locator("#signin")], ["@email", page.locator("#email")]]);
      const pageBridge = { goto: async () => undefined, locator: page.locator.bind(page), url: page.url.bind(page) };
      const adapter = { setCurrentThread: () => undefined, ensureReady: async () => undefined, getManagerForThread: async () => ({ getPage: () => pageBridge, getLocatorFromRef: (ref: string) => refs.get(ref) }) };
      let finalClicks = 0;
      const deps = {
        getConfig: () => ({ agentModel: { id: "openai/gpt-5.6-luna", apiKey: "x" }, browserModel: { modelName: "openai/gpt-5.6-luna", apiKey: "x" }, label: "fixture", secrets: [] }),
        createRuntime: (_a: unknown, _b: unknown, _c: unknown, ledger: ReturnType<typeof createRunLedger>) => ({ mastra: { getAgentById: () => ({ stream: async () => {
          const tools = createGeneralApplicationTools(adapter as never, { facts: { "personal.email": "fixture@example.test" }, reusableAnswers: {} }, { handles: ["username", "password"], resolve: (key) => key === "username" ? "fixture-user" : "fixture-password" }, ledger);
          await tools.fill_credential.execute({ ref: "@user", credentialHandle: "username" }, { agent: { threadId: "run" } } as never);
          await tools.fill_credential.execute({ ref: "@password", credentialHandle: "password" }, { agent: { threadId: "run" } } as never);
          await tools.submit_authentication.execute({ ref: "@signin" }, { agent: { threadId: "run" } } as never);
          await tools.fill_fact.execute({ ref: "@email", factKey: "personal.email" }, { agent: { threadId: "run" } } as never);
          return { fullStream: new ReadableStream({ start(controller) { controller.close(); } }) };
        } }) }, browsers: { actionBrowser: adapter, close: async () => undefined } }),
        inspect: inspectCurrentPage, screenshot: async () => "/fixture/auth-ready.png", clickRef: async () => { finalClicks += 1; }, clickLabel: async () => { finalClicks += 1; }, createRunId: () => "run",
        now: Date.now, wait: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      };
       const result = await applyJobWithDependencies({ applicationUrl: "http://localhost/fixture", catalog: { facts: { "personal.email": "fixture@example.test" }, reusableAnswers: {} }, credentials: { handles: ["username", "password"], resolve: () => "unused" }, submit: false }, deps as never);
      expect(result).toMatchObject({ status: "ready_to_submit", screenshotPath: "/fixture/auth-ready.png" });
      expect(await page.evaluate(() => (window as any).loginClicks)).toBe(1);
      expect(finalClicks).toBe(0);
      expect(result.trace).toEqual(expect.arrayContaining(["Used approved credential username", "Used approved credential password", "Completed field from approved fact personal.email"]));
    } finally { await browser.close(); }
  }, 15_000);
});
