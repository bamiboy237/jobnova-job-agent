import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Synthetic/private candidate input for the general application agent and the
 * provided Lever proof. It is compatibility input, not an architecture boundary.
 *
 * Every value is clearly fictitious: an example.com email, a fictional
 * NANP 555-01xx phone number, and a fictional identity. The profile is the
 * deterministic program input for the application agent; the agent must
 * never invent any value outside this object. The `isSynthetic` flag makes
 * the label machine-checkable.
 */

export interface CandidateProfile {
  isSynthetic: boolean;
  fullName: string;
  email: string;
  phone: string;
  currentLocation: string;
  currentCompany: string;
  noticePeriod: "1 month" | "2 months" | "3 months" | "6 months" | "Available now";
  idealStartMonth: string;
  expectedSalaryRange: string;
  applicationSource: string;
  discoverySource: string;
  workAuthorization: "citizen_or_permanent_resident" | "currently_authorized" | "requires_sponsorship";
  visaDetails: string;
  openToNewYorkOfficeThreeDaysPerWeek: boolean;
  preferredCodingLanguage: string;
  gender: "Prefer not to say";
  ethnicity: "Prefer not to say";
  ageBracket: "Prefer not to say";
  consentToTwoYearRetention: boolean;
  approvedResumeId: "primary";
}

export type SyntheticCandidateProfile = CandidateProfile & { isSynthetic: true };

export const CANDIDATE_PROFILE_PATH = path.resolve(process.cwd(), "data", "candidate", "profile.json");

const StoredCandidateProfileSchema = z.object({
  isSynthetic: z.literal(false),
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  currentLocation: z.string().min(1),
  currentCompany: z.string().min(1),
  noticePeriod: z.enum(["1 month", "2 months", "3 months", "6 months", "Available now"]),
  idealStartMonth: z.string().min(1),
  expectedSalaryRange: z.string().min(1),
  applicationSource: z.string().min(1),
  discoverySource: z.string().min(1),
  workAuthorization: z.enum(["citizen_or_permanent_resident", "currently_authorized", "requires_sponsorship"]),
  visaDetails: z.string().min(1),
  openToNewYorkOfficeThreeDaysPerWeek: z.boolean(),
  preferredCodingLanguage: z.string().min(1),
  gender: z.literal("Prefer not to say"),
  ethnicity: z.literal("Prefer not to say"),
  ageBracket: z.literal("Prefer not to say"),
  consentToTwoYearRetention: z.boolean(),
  approvedResumeId: z.literal("primary"),
});

export type CandidateProfileLoadResult =
  | { ok: true; profile: CandidateProfile }
  | { ok: false; error: string };

/** Loads and validates the private factual profile used for real submission. */
export async function loadCandidateProfile(filePath: string = CANDIDATE_PROFILE_PATH): Promise<CandidateProfileLoadResult> {
  try {
    const parsed = StoredCandidateProfileSchema.safeParse(JSON.parse(await fs.readFile(filePath, "utf8")));
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "profile"))];
      return { ok: false, error: `Candidate profile is incomplete or invalid: ${fields.join(", ")}` };
    }
    return { ok: true, profile: parsed.data };
  } catch (error) {
    return { ok: false, error: `Could not load candidate profile: ${error instanceof Error ? error.message : String(error)}` };
  }
}


export function createSyntheticProfile(): SyntheticCandidateProfile {
  return {
    isSynthetic: true,
    fullName: "Taylor Alex Sample",
    email: "taylor.sample@example.com",
    phone: "+1 (555) 010-4242",
    currentLocation: "New York, NY",
    currentCompany: "Example Corp",
    noticePeriod: "1 month",
    idealStartMonth: "March",
    expectedSalaryRange: "$110,000 - $130,000",
    applicationSource: "Job board",
    discoverySource: "LinkedIn",
    workAuthorization: "citizen_or_permanent_resident",
    visaDetails: "None required — synthetic profile is a U.S. citizen",
    openToNewYorkOfficeThreeDaysPerWeek: true,
    preferredCodingLanguage: "Python",
    gender: "Prefer not to say",
    ethnicity: "Prefer not to say",
    ageBracket: "Prefer not to say",
    consentToTwoYearRetention: true,
    approvedResumeId: "primary",
  };
}

/** A value is missing when it is undefined, null, or blank text. */
export function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}
