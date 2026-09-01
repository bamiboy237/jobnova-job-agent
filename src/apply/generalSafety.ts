import { normalizeOption, requiredGaps, type PageControl, type PageState } from "./pageState.js";

export function isFinalControl(control: PageControl): boolean {
  return control.progression === "final-submit";
}
export function uniqueFinalControl(state: PageState): PageControl | undefined {
  const matches = state.controls.filter((control) => control.visible && control.enabled && isFinalControl(control));
  if (matches.length === 1) return matches[0];
  const first = matches[0];
  if (!first?.formIdentity) return undefined;
  const equivalent = matches.every((control) => control.formIdentity === first.formIdentity && normalizeOption(control.label) === normalizeOption(first.label));
  return equivalent ? matches.at(-1) : undefined;
}
export function finalAudit(state: PageState, completedCount: number): { ok: boolean; missingRequired: string[]; error?: string; final?: PageControl } {
  if (state.unsupportedVisibleFrameCount) return { ok: false, missingRequired: [], error: "Visible embedded frame is unsupported; application cannot be safely audited" };
  const missingRequired = requiredGaps(state.controls).map((control) => control.label || control.identity);
  if (missingRequired.length) return { ok: false, missingRequired, error: "Visible required controls remain incomplete" };
  if (!completedCount) return { ok: false, missingRequired, error: "No completed application field or artifact is recorded" };
  const final = uniqueFinalControl(state);
  if (!final) return { ok: false, missingRequired, error: "Could not identify exactly one visible enabled final submission control" };
  return { ok: true, missingRequired, final };
}
export function isConfirmedApplication(state: PageState): boolean {
  return state.intent === "confirmation" || /\/(thanks?|confirmation|submitted|success|applied|done)\/?$/i.test(new URL(state.url).pathname);
}
/** Confirmation must be a visible transition on the controller-owned page and origin. */
export function isBoundConfirmation(before: PageState, after: PageState): boolean {
  try {
    if (new URL(before.url).origin !== new URL(after.url).origin || !isConfirmedApplication(after)) return false;
    return before.url !== after.url || before.fingerprint !== after.fingerprint;
  }
  catch { return false; }
}
