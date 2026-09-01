export interface LedgerCompletion { identity: string; source: "fact" | "answer" | "resume" | "credential"; key: string; }
export interface ApplicationRunLedger {
  completed: LedgerCompletion[];
  validatedFingerprints: string[];
  latest?: { action: string; before?: string; after?: string; changed: boolean };
  noProgressCount: number;
  submissionAttempted: boolean;
}

export function createRunLedger(): ApplicationRunLedger {
  return { completed: [], validatedFingerprints: [], noProgressCount: 0, submissionAttempted: false };
}
export function recordCompletion(ledger: ApplicationRunLedger, completion: LedgerCompletion): void {
  if (!ledger.completed.some((item) => item.identity === completion.identity && item.source === completion.source && item.key === completion.key)) ledger.completed.push(completion);
}
export function recordTransition(ledger: ApplicationRunLedger, action: string, before: string, after: string): boolean {
  const changed = before !== after;
  ledger.latest = { action, before, after, changed };
  ledger.noProgressCount = changed ? 0 : ledger.noProgressCount + 1;
  return changed;
}
export function recordValidatedStep(ledger: ApplicationRunLedger, fingerprint: string): void {
  if (!ledger.validatedFingerprints.includes(fingerprint)) ledger.validatedFingerprints.push(fingerprint);
}
export function markSubmissionAttempted(ledger: ApplicationRunLedger): boolean {
  if (ledger.submissionAttempted) return false;
  ledger.submissionAttempted = true;
  return true;
}
