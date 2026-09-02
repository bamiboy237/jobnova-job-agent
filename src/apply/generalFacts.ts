/** Employer- and ATS-independent approved candidate data for application tools. */
export type FactValue = string | boolean | number;
export type FactKey = string;

/** Server-owned vocabulary permitted in persisted prompts and protected tools. */
export const TRUSTED_FACT_KEYS = [
  "fullName", "firstName", "lastName", "email", "phone", "phoneDigits", "currentLocation", "currentCompany", "noticePeriod", "idealStartMonth", "expectedSalaryRange", "applicationSource", "discoverySource", "workAuthorization", "visaDetails", "openToNewYorkOfficeThreeDaysPerWeek", "preferredCodingLanguage", "gender", "ethnicity", "ageBracket", "consentToTwoYearRetention",
  "degree", "school", "fieldOfStudy", "graduationYear", "gpa", "hasGovernmentExperience", "requiresSponsorship", "hasValidWorkPermit", "hasValidResidencyPermit", "hasNonCompeteRestrictions", "sponsorshipCountries",
  "personal.name.full", "personal.email", "personal.phone", "authorization.sponsorship", "preferences.remote", "skills.primary",
] as const;
export const TRUSTED_REUSABLE_ANSWER_KEYS = ["application.cover_letter", "cover"] as const;
export const TRUSTED_RESUME_IDS = ["primary"] as const;
export const TRUSTED_CREDENTIAL_HANDLES = ["username", "email", "password", "ats-username", "ats-email", "ats-password", "password-handle"] as const;
export function isTrustedCapability(kind: "fact" | "answer" | "resume" | "credential", value: string): boolean {
  const values = kind === "fact" ? TRUSTED_FACT_KEYS : kind === "answer" ? TRUSTED_REUSABLE_ANSWER_KEYS : kind === "resume" ? TRUSTED_RESUME_IDS : TRUSTED_CREDENTIAL_HANDLES;
  return (values as readonly string[]).includes(value);
}

export interface CandidateFactCatalog {
  facts: Readonly<Record<FactKey, FactValue>>;
  reusableAnswers: Readonly<Record<string, FactValue>>;
  approvedResumeId?: string;
}

export type FactResolution =
  | { ok: true; key: string; value: FactValue }
  | { ok: false; key: string; error: `Missing approved fact: ${string}` }
  | { ok: false; error: "Unapproved fact key" | "Unapproved reusable-answer key" };

export function resolveFact(catalog: CandidateFactCatalog, key: string): FactResolution {
  if (!isTrustedCapability("fact", key)) return { ok: false, error: "Unapproved fact key" };
  const value = catalog.facts[key];
  if (isMissing(value)) return { ok: false, key, error: `Missing approved fact: ${key}` };
  return { ok: true, key, value };
}

export function resolveReusableAnswer(catalog: CandidateFactCatalog, key: string): FactResolution {
  if (!isTrustedCapability("answer", key)) return { ok: false, error: "Unapproved reusable-answer key" };
  const value = catalog.reusableAnswers[key];
  if (isMissing(value)) return { ok: false, key, error: `Missing approved fact: reusable.${key}` };
  return { ok: true, key, value };
}

export function isMissing(value: unknown): value is undefined | null | "" {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}
