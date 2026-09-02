import type { AgentBrowser } from "@mastra/agent-browser";
import path from "node:path";
import type { Locator } from "playwright-core";
import { classifyAuthenticationMode, classifyControlIntent, classifyPageIntent, extractApplicationId, fingerprintPage, type ControlKind, type PageControl, type PageState, type ValidationState } from "./pageState.js";

interface ControlRecord extends Omit<PageControl, "url" | "frame" | "snapshotRef" | "progression" | "optionRefs"> {
  radioGroup?: string;
  radioGroupLabel?: string;
}

/**
 * Isolated bridge to AgentBrowser's manager/page/ref Locator surface.
 * It inspects only the main document. Shadow roots and cross-origin frames are
 * intentionally not inspected.
 */
export async function inspectCurrentPage(browser: AgentBrowser, refs: string[] = [], threadId?: string): Promise<PageState> {
  const manager = await browser.getManagerForThread(threadId);
  const page = manager.getPage();
  const url = page.url();
  const allControls = page.locator("input, textarea, select, button, [role=radio], [role=checkbox], [role=combobox], [role=listbox], [role=option]");
  const discovered = (await Promise.all(Array.from({ length: await allControls.count() }, (_, index) =>
    allControls.nth(index).evaluate(inspectElement, index).catch(() => undefined),
  ))).filter((control): control is ControlRecord => Boolean(control && (control.kind !== "option" || control.visible)));

  // Reinspect each snapshot ref directly. Identity is a unique DOM path, not
  // a name/label, so siblings such as Yes/No radios remain independently targetable.
  const refRecords = await Promise.all(refs.map(async (ref) => {
    const locator = manager.getLocatorFromRef(ref);
    if (!locator) return undefined;
    const control = await locator.evaluate(inspectElement, 0).catch(() => undefined);
    return control ? { ...control, snapshotRef: ref } : undefined;
  }));
  const byIdentity = new Map<string, ControlRecord & { snapshotRef?: string }>();
  for (const control of discovered) byIdentity.set(control.identity, control);
  for (const control of refRecords) {
    if (!control) continue;
    byIdentity.set(control.identity, { ...(byIdentity.get(control.identity) ?? control), ...control });
  }
  const text = await page.locator("body").innerText().catch(() => "");
  const controls = collapseRadioGroups([...byIdentity.values()]).map((control) => ({
    ...control, url, frame: "main" as const, progression: classifyControlIntent(control.label, control.kind),
  }));
  const frameLocator = page.locator("iframe") as { evaluateAll?: (fn: (frames: Element[]) => { count: number; activeChallenge: boolean }) => Promise<{ count: number; activeChallenge: boolean }> };
  const frameCount = frameLocator.evaluateAll ? await frameLocator.evaluateAll((frames) => {
    let count = 0;
    let activeChallenge = false;
    for (const frame of frames) {
      if (!(frame instanceof HTMLElement)) continue;
      const style = getComputedStyle(frame);
      const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0 && frame.offsetWidth >= 200 && frame.offsetHeight >= 100;
      if (!visible) continue;
      count += 1;
      if (/https?:\/\/(?:[^/]+\.)?(?:google\.com\/recaptcha|recaptcha\.net\/recaptcha|hcaptcha\.com(?:\/|$)|arkoselabs\.com(?:\/|$)|challenges\.cloudflare\.com(?:\/|$))/i.test(frame.getAttribute("src") || "")) activeChallenge = true;
    }
    return { count, activeChallenge };
  }).catch(() => ({ count: 0, activeChallenge: false })) : { count: 0, activeChallenge: false };
  const intent = classifyPageIntent(url, text, controls, frameCount.activeChallenge);
  const state: Omit<PageState, "fingerprint"> = { url, frame: "main", intent, controls, authenticationMode: intent === "authentication" ? classifyAuthenticationMode(url, text, controls) : undefined, applicationId: intent === "confirmation" ? extractApplicationId(text) : undefined, unsupportedVisibleFrameCount: frameCount.count };
  return { ...state, fingerprint: fingerprintPage(state) };
}

export async function inspectControlRef(browser: AgentBrowser, ref: string, threadId?: string): Promise<PageControl | undefined> {
  const manager = await browser.getManagerForThread(threadId);
  const locator = manager.getLocatorFromRef(ref);
  if (!locator) return undefined;
  const url = manager.getPage().url();
  const control = await locator.evaluate(inspectElement, 0).catch(() => undefined);
  return control ? { ...control, url, frame: "main", snapshotRef: ref, progression: classifyControlIntent(control.label, control.kind) } : undefined;
}

export async function fillControlRef(browser: AgentBrowser, ref: string, value: string, threadId?: string): Promise<void> {
  await (await requiredLocator(browser, ref, threadId)).fill(value);
}
export async function selectControlRef(browser: AgentBrowser, ref: string, option: string, threadId?: string): Promise<void> {
  await (await requiredLocator(browser, ref, threadId)).selectOption({ label: option });
}
export async function selectCustomOptionRef(browser: AgentBrowser, ref: string, option: string, threadId?: string): Promise<void> {
  const manager = await browser.getManagerForThread(threadId);
  await (await requiredLocator(browser, ref, threadId)).click();
  const options = manager.getPage().locator('[role="option"]');
  await options.first().waitFor({ state: "visible", timeout: 5_000 });
  const target = normalizeVisibleText(option);
  const matches: number[] = [];
  const records = await options.evaluateAll((elements) => elements.map((element) => ({
    label: (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim(),
    visible: element instanceof HTMLElement && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
    enabled: element.getAttribute("aria-disabled") !== "true",
  })));
  records.forEach((record, index) => { if (record.visible && record.enabled && normalizeVisibleText(record.label) === target) matches.push(index); });
  if (matches.length !== 1) throw new Error("Custom option is missing or ambiguous");
  await options.nth(matches[0]).click();
}
export async function clickControlRef(browser: AgentBrowser, ref: string, threadId?: string): Promise<void> {
  const locator = await requiredLocator(browser, ref, threadId);
  const before = await locator.evaluate(inspectElement, 0);
  if (before?.kind !== "checkbox" && before?.kind !== "radio") {
    await locator.click();
    return;
  }

  await locator.click().catch(() => {});
  const afterClick = await locator.evaluate(inspectElement, 0).catch(() => undefined);
  if (afterClick && afterClick.filled !== before.filled) return;

  await locator.focus();
  await locator.press("Space");
  const afterKeyboard = await locator.evaluate(inspectElement, 0).catch(() => undefined);
  if (!afterKeyboard || afterKeyboard.filled === before.filled) throw new Error("Control mutation failed");
}
/** Controller-only fallback when a fresh inspection has no snapshot ref. */
export async function clickUniqueButtonLabel(browser: AgentBrowser, label: string, threadId?: string): Promise<void> {
  const page = (await browser.getManagerForThread(threadId)).getPage();
  const controls = page.locator('button, input[type="submit"], input[type="button"], [role="button"]');
  const matches: number[] = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    const current = await controls.nth(index).evaluate((element) => ({
      visible: element instanceof HTMLElement && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
      enabled: !("disabled" in element && Boolean((element as HTMLButtonElement).disabled)) && element.getAttribute("aria-disabled") !== "true",
      label: (element.getAttribute("aria-label") || ("value" in element ? String((element as HTMLInputElement).value ?? "") : "") || element.textContent || "").replace(/\s+/g, " ").trim(),
    }));
    if (current.visible && current.enabled && current.label === label) matches.push(index);
  }
  if (matches.length !== 1) throw new Error("Final submission control is ambiguous or stale");
  await controls.nth(matches[0]).click();
}
export async function uploadControlRef(browser: AgentBrowser, ref: string, filePath: string, threadId?: string): Promise<void> {
  const locator = await requiredLocator(browser, ref, threadId);
  const before = await uploadContainerSignature(locator);
  await locator.setInputFiles(filePath);
  if (!await verifyUpload(locator, path.basename(filePath), before)) throw new Error("Browser selected the file, but the page did not confirm the attachment");
}
export async function uploadUniqueFileInput(browser: AgentBrowser, filePath: string, threadId?: string): Promise<void> {
  const page = (await browser.getManagerForThread(threadId)).getPage();
  const inputs = page.locator('input[type="file"]:not([disabled])');
  if (await inputs.count() !== 1) throw new Error("File input is missing or ambiguous");
  const input = inputs.first();
  const before = await uploadContainerSignature(input);
  await input.setInputFiles(filePath);
  if (!await verifyUpload(input, path.basename(filePath), before)) throw new Error("Browser selected the file, but the page did not confirm the attachment");
}

async function requiredLocator(browser: AgentBrowser, ref: string, threadId?: string) {
  const locator = (await browser.getManagerForThread(threadId)).getLocatorFromRef(ref);
  if (!locator) throw new Error("Snapshot ref is stale or unknown");
  return locator;
}

function collapseRadioGroups(controls: Array<ControlRecord & { snapshotRef?: string }>): Array<ControlRecord & { snapshotRef?: string; optionRefs?: string[] }> {
  const output: Array<ControlRecord & { snapshotRef?: string; optionRefs?: string[] }> = [];
  const groups = new Map<string, Array<ControlRecord & { snapshotRef?: string }>>();
  for (const control of controls) {
    if (control.kind !== "radio" || !control.radioGroup) output.push(control);
    else groups.set(control.radioGroup, [...(groups.get(control.radioGroup) ?? []), control]);
  }
  for (const [group, members] of groups) {
    const first = members[0];
    output.push({
      ...first, identity: `radio-group:${group}`, label: members.find((member) => member.radioGroupLabel)?.radioGroupLabel || first.label || group,
      required: members.some((member) => member.required), visible: members.some((member) => member.visible),
      enabled: members.some((member) => member.enabled), filled: members.some((member) => member.filled),
      options: members.map((member) => member.label), optionRefs: members.flatMap((member) => member.snapshotRef ? [member.snapshotRef] : []),
      groupIdentity: group,
    });
  }
  return output;
}

function inspectElement(element: Element, index: number): ControlRecord | undefined {
  const html = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
  const style = element instanceof HTMLElement && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  const role = element.getAttribute("role")?.toLowerCase();
  const inputType = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
  if (inputType === "hidden" || inputType === "reset") return undefined;
  const kind: ControlKind = role === "radio" || inputType === "radio" ? "radio" : role === "checkbox" || inputType === "checkbox" ? "checkbox"
    : role === "combobox" ? "combobox" : role === "listbox" ? "listbox" : role === "option" ? "option"
    : element instanceof HTMLSelectElement ? "select" : element instanceof HTMLTextAreaElement ? "textarea"
    : inputType === "file" ? "file" : element instanceof HTMLButtonElement || inputType === "button" || inputType === "submit" ? "button" : element instanceof HTMLInputElement ? "text" : "unknown";
  const nativeLabel = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement)
    ? element.labels?.[0]?.textContent : undefined;
  const buttonValue = kind === "button" && "value" in html ? String(html.value ?? "") : "";
  const roleText = role ? element.textContent : "";
  const label = (element.getAttribute("aria-label") || element.closest("label")?.textContent || nativeLabel || buttonValue || element.getAttribute("name") || roleText || element.textContent || element.id || "").replace(/\s+/g, " ").trim();
  let identity = element.id ? `id:${element.id}` : "";
  if (!identity) {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 12) {
      const parent: Element | null = current.parentElement;
      const siblingIndex = parent ? Array.prototype.indexOf.call(parent.children, current) + 1 : index + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${siblingIndex})`);
      current = parent;
    }
    identity = parts.join(">");
  }
  const radioContainer = kind === "radio"
    ? (element.closest("[role=radiogroup]") || element.closest("fieldset") || element.closest("[role=group], .application-question, [data-question]"))
    : null;
  let radioContainerIdentity = "";
  let semanticRadioLabel = "";
  if (radioContainer) {
    const labelledIds = radioContainer.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
    const labelledParts: string[] = [];
    for (const id of labelledIds) labelledParts.push(document.getElementById(id)?.textContent || "");
    semanticRadioLabel = labelledParts.join(" ").replace(/\s+/g, " ").trim() || radioContainer.getAttribute("aria-label") || "";
    if (!semanticRadioLabel) {
      const legend = radioContainer instanceof HTMLFieldSetElement ? radioContainer.querySelector("legend")?.textContent : undefined;
      const questionLabel = radioContainer.querySelector("[data-question-label], .question-label, .application-label, legend")?.textContent;
      semanticRadioLabel = (legend || questionLabel || "").replace(/\s+/g, " ").trim();
    }
    radioContainerIdentity = radioContainer.id ? `id:${radioContainer.id}` : "";
    if (!radioContainerIdentity) {
      const parts: string[] = [];
      let current: Element | null = radioContainer;
      while (current && parts.length < 12) {
        const parent: Element | null = current.parentElement;
        const siblingIndex = parent ? Array.prototype.indexOf.call(parent.children, current) + 1 : index + 1;
        parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${siblingIndex})`);
        current = parent;
      }
      radioContainerIdentity = parts.join(">");
    }
  }
  const selected = element.getAttribute("aria-selected") === "true";
  const checked = selected || element.getAttribute("aria-checked") === "true" || ("checked" in html && Boolean(html.checked));
  const value = inputType === "password" ? "" : ("value" in html ? String(html.value ?? "") : "");
  const options: string[] = [];
  if (element instanceof HTMLSelectElement) {
    for (const option of Array.from(element.options)) options.push(option.text.trim());
  } else if (role === "listbox" || role === "combobox") {
    for (const option of Array.from(element.querySelectorAll('[role="option"]'))) {
      const text = (option.textContent || "").trim();
      if (text) options.push(text);
    }
  }
  const validation: ValidationState | undefined = element.getAttribute("aria-invalid") === "true" ? "invalid"
    : ("validity" in html && html.validity?.valueMissing) ? "required"
    : ("validity" in html && html.validity && !html.validity.valid) ? "invalid" : undefined;
  const radioGroup = kind === "radio" ? (inputType === "radio" && element.getAttribute("name")
    ? `native:${element.getAttribute("name")}` : `aria:${radioContainerIdentity || identity}`) : undefined;
  const required = element.hasAttribute("required") || element.getAttribute("aria-required") === "true"
    || radioContainer?.getAttribute("aria-required") === "true" || Boolean(radioContainer?.querySelector("input[type=radio][required]"))
    || /(?:\*|\(required\))\s*$/i.test(label);
  const form = element.closest("form");
  const formIdentity = form ? (form.id ? `id:${form.id}` : form.getAttribute("action") ? `action:${form.getAttribute("action")}` : "nearest-form") : undefined;
  return {
    identity, label, kind,
    required, visible: style,
    enabled: !("disabled" in html && Boolean(html.disabled)) && element.getAttribute("aria-disabled") !== "true",
    filled: kind === "listbox" || kind === "combobox" ? Boolean(element.querySelector('[role="option"][aria-selected="true"]'))
      : kind === "radio" || kind === "checkbox" || kind === "option" ? checked : kind === "file" ? Boolean((html as HTMLInputElement).files?.length)
        : inputType === "password" ? html.value.length > 0 : Boolean(value.trim()),
    options, validation, groupIdentity: radioGroup, radioGroup, radioGroupLabel: semanticRadioLabel || undefined, formIdentity,
    challengeEvidence: /captcha|recaptcha|hcaptcha|arkose|turnstile|verify (?:that )?you are human|i(?:'|’)m not a robot/.test(`${label} ${element.id} ${element.getAttribute("name") || ""}`.toLowerCase()) ? "visible challenge control" : undefined,
    credentialHint: inputType === "password" ? "password" : /one-time-code|otp|verification|verify|code/.test(`${element.getAttribute("autocomplete") || ""} ${element.getAttribute("name") || ""} ${element.id} ${element.getAttribute("aria-label") || ""}`.toLowerCase()) ? "verification" : /email|user(name)?/.test(`${element.getAttribute("autocomplete") || ""} ${element.getAttribute("name") || ""} ${element.id}`.toLowerCase()) ? "username" : undefined,
  };
}

function normalizeVisibleText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

async function uploadContainerSignature(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const container = element.closest("label, [role=group], form, section, div") || element.parentElement;
    return `${container?.textContent || ""}\n${container?.innerHTML || ""}`;
  });
}

async function verifyUpload(locator: Locator, fileName: string, beforeSignature: string): Promise<boolean> {
  return locator.evaluate(async (element, evidence) => {
    const fileInput = element as HTMLInputElement;
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.length) return false;
    const deadline = Date.now() + 10_000;
    let observedProgress = false;
    while (Date.now() < deadline) {
      const bodyText = document.body?.innerText || "";
      if (bodyText.includes(evidence.fileName)) return true;
      const container = fileInput.closest("label, [role=group], form, section, div") || fileInput.parentElement;
      const progress = container?.querySelector('[aria-busy="true"], [role="progressbar"], [data-uploading="true"]');
      if (progress) observedProgress = true;
      else if (observedProgress) return true;
      const signature = `${container?.textContent || ""}\n${container?.innerHTML || ""}`;
      if (signature !== evidence.beforeSignature) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }, { fileName, beforeSignature });
}
