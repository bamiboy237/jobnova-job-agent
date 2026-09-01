import { applyJob } from "./applyJob.js";
import { createSyntheticProfile, type CandidateProfile } from "./profile.js";
import type { ApplicationResult } from "./applicationResult.js";
import { candidateProfileToCatalog } from "./candidateCatalog.js";

/** Temporary compatibility default for existing CLI callers; no URL policy depends on Lever. */
export const EKIMETRICS_LEVER_APPLY_URL = "https://jobs.lever.co/ekimetrics/d9d64766-3d42-4ba9-94d4-f74cdaf20065/apply";
export interface ApplyLeverInput { applyUrl?: string; profile?: CandidateProfile; resumeId?: string; submit?: boolean; }

/** @deprecated Use applyJob with a CandidateFactCatalog. */
export async function applyEkimetricsLever(input: ApplyLeverInput = {}): Promise<ApplicationResult> {
  const profile = input.profile ?? createSyntheticProfile();
  if (input.submit && profile.isSynthetic) return {
    status: "blocked", jobUrl: input.applyUrl ?? EKIMETRICS_LEVER_APPLY_URL, fieldsCompleted: [], missingRequired: [], runtimeMs: 0,
    trace: ["Submission authorization rejected"], error: "Synthetic candidate data cannot be submitted; load an approved factual candidate profile",
  };
  const resumeId = input.resumeId ?? profile.approvedResumeId;
  return applyJob({ applicationUrl: input.applyUrl ?? EKIMETRICS_LEVER_APPLY_URL, catalog: candidateProfileToCatalog(profile, resumeId), resumeId, submit: input.submit });
}
