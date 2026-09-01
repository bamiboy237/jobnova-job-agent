import { isTrustedCapability, type CandidateFactCatalog } from "./generalFacts.js";
import type { CandidateProfile } from "./profile.js";

/** Compatibility conversion from private profile input to code-owned fact vocabulary. */
export function candidateProfileToCatalog(profile: CandidateProfile, resumeId: string = profile.approvedResumeId): CandidateFactCatalog {
  const facts = Object.fromEntries(Object.entries(profile).filter(([key, value]) => isTrustedCapability("fact", key) && (typeof value === "string" || typeof value === "boolean" || typeof value === "number")));
  return { facts, reusableAnswers: {}, approvedResumeId: isTrustedCapability("resume", resumeId) ? resumeId : undefined };
}
