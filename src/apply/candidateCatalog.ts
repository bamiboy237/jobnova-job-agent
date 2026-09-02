import { isTrustedCapability, type CandidateFactCatalog } from "./generalFacts.js";
import type { CandidateProfile } from "./profile.js";

/** Compatibility conversion from private profile input to code-owned fact vocabulary. */
export function candidateProfileToCatalog(profile: CandidateProfile, resumeId: string = profile.approvedResumeId): CandidateFactCatalog {
  const nameParts = profile.fullName.trim().split(/\s+/);
  const digits = profile.phone.replace(/\D/g, "");
  const derived = {
    firstName: nameParts[0] ?? "",
    lastName: nameParts.slice(1).join(" "),
    phoneDigits: digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits,
  };
  const facts = Object.fromEntries(Object.entries({ ...derived, ...profile }).filter(([key, value]) => isTrustedCapability("fact", key) && (typeof value === "string" || typeof value === "boolean" || typeof value === "number")));
  return { facts, reusableAnswers: {}, approvedResumeId: isTrustedCapability("resume", resumeId) ? resumeId : undefined };
}
