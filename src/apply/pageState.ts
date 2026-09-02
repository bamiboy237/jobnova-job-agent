import { createHash } from "node:crypto";

export type ControlKind =
  | "text" | "textarea" | "select" | "file" | "radio" | "checkbox" | "button"
  | "combobox" | "listbox" | "option" | "unknown";
export type PageIntent = "application" | "authentication" | "challenge" | "confirmation" | "unknown";
export type AuthenticationMode = "login" | "verification" | "account-creation";
export type ProgressionIntent = "none" | "next" | "previous" | "final-submit";
export type ValidationState = "required" | "invalid";

export interface PageControl {
  identity: string;
  snapshotRef?: string;
  frame: "main";
  url: string;
  label: string;
  kind: ControlKind;
  required: boolean;
  visible: boolean;
  enabled: boolean;
  filled: boolean;
  options: string[];
  /** Safe validation category. Native validation messages are never exposed. */
  validation?: ValidationState;
  /** Snapshot refs for individual radio/ARIA option actions, never fingerprinted. */
  optionRefs?: string[];
  /** Value-free identity for a radio/ARIA choice group. */
  groupIdentity?: string;
  progression: ProgressionIntent;
  /** Value-free identity used only to disambiguate duplicate controls in one form. */
  formIdentity?: string;
  authEvidence?: string;
  challengeEvidence?: string;
  credentialHint?: "password" | "username" | "verification";
}

export interface PageState {
  url: string;
  frame: "main";
  intent: PageIntent;
  controls: PageControl[];
  fingerprint: string;
  /** Bounded non-candidate identifier found only on a confirmation page. */
  applicationId?: string;
  unsupportedVisibleFrameCount?: number;
  authenticationMode?: AuthenticationMode;
}

export function isAllowedApplicationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch { return false; }
}

export function normalizeOption(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Returns an exact or uniquely contained normalized option. */
export function exactOptionMatch(options: string[], value: string | boolean | number): string | undefined {
  const target = normalizeOption(typeof value === "boolean" ? value ? "Yes" : "No" : String(value));
  const exact = options.filter((option) => normalizeOption(option) === target);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  if (target.length < 3) return undefined;
  const contained = options.filter((option) => {
    const normalized = normalizeOption(option);
    return normalized.length >= 3 && (normalized.includes(target) || target.includes(normalized));
  });
  return contained.length === 1 ? contained[0] : undefined;
}

export function requiredGaps(controls: PageControl[]): PageControl[] {
  return controls.filter((control) => control.visible && control.enabled && control.required && !control.filled);
}

export function classifyControlIntent(label: string, kind: ControlKind): ProgressionIntent {
  if (kind !== "button") return "none";
  const normalized = normalizeOption(label);
  if (/^(submit|submit (?:my )?application|complete application|finish application|send application|apply now)$/.test(normalized)) return "final-submit";
  if (/^(next(?: step|: .*)?|continue|save (?:&|and) continue|proceed)$/.test(normalized)) return "next";
  if (/^(back|previous)\b/.test(normalized)) return "previous";
  return "none";
}

/** Extracts only explicit labelled confirmation identifiers, never arbitrary page text. */
export function extractApplicationId(text: string): string | undefined {
  const match = text.match(/\b(?:application\s*(?:id|reference)|confirmation\s*number|reference\s*id)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9-]{5,63})\b/i);
  return match?.[1];
}

export function classifyAuthenticationMode(url: string, text: string, controls: PageControl[] = []): AuthenticationMode | undefined {
  const evidence = normalizeOption(`${url} ${text}`);
  const credential = controls.some((control) => control.visible && (control.credentialHint === "password" || control.credentialHint === "username"));
  const secureCredential = controls.some((control) => control.visible && (control.credentialHint === "password" || control.credentialHint === "verification"));
  const verification = controls.some((control) => control.visible && control.credentialHint === "verification");
  const loginAction = controls.some((control) => control.visible && control.kind === "button" && /^(sign in|log in|login)$/i.test(control.label));
  const accountAction = controls.some((control) => control.visible && control.kind === "button" && /^(create account|register|sign up)$/i.test(control.label));
  if (/create account|register|sign up/.test(evidence) && (secureCredential || accountAction)) return "account-creation";
  if (/email verification|two.factor|mfa|one.time.code|verification code/.test(evidence) && verification) return "verification";
  if (credential && loginAction) return "login";
  return undefined;
}

export function classifyPageIntent(url: string, text: string, controls: PageControl[] = [], visibleChallengeFrame = false): PageIntent {
  const evidence = normalizeOption(`${url} ${text}`);
  const visibleChallengeControl = controls.some((control) =>
    control.visible && (
      Boolean(control.challengeEvidence) ||
      /captcha|recaptcha|hcaptcha|arkose|turnstile|verify (?:that )?you are human|i(?:'|’)m not a robot/.test(normalizeOption(control.label))
    ));
  if (visibleChallengeFrame || visibleChallengeControl) return "challenge";
  if (/thank you for applying|application (has been |was )?(submitted|received)/.test(evidence)) return "confirmation";
  if (classifyAuthenticationMode(url, text, controls)) return "authentication";
  if (/application|apply|resume|cv/.test(evidence)) return "application";
  return "unknown";
}

/** A deterministic, value-free representation of material page state. */
export function fingerprintPage(input: Pick<PageState, "url" | "frame" | "intent" | "controls" | "unsupportedVisibleFrameCount" | "authenticationMode">): string {
  const stable = JSON.stringify({
    url: input.url, frame: input.frame, intent: input.intent, authenticationMode: input.authenticationMode, unsupportedVisibleFrameCount: input.unsupportedVisibleFrameCount ?? 0,
    controls: input.controls.map(({ identity, label, kind, required, visible, enabled, filled, options, progression, validation, groupIdentity, formIdentity }) =>
      ({ identity, label, kind, required, visible, enabled, filled, options, progression, validation, groupIdentity, formIdentity })),
  });
  return createHash("sha256").update(stable).digest("hex");
}
