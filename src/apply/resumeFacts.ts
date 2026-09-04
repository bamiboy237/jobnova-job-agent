import fs from "node:fs/promises";
import path from "node:path";
import { isTrustedCapability, type CandidateFactCatalog, type FactValue } from "./generalFacts.js";

/** Facts file lives next to the profile. Tests point it at a temp dir. */
export function resumeFactsPath(): string {
  return process.env.JOBNOVA_RESUME_FACTS_PATH ?? path.resolve(process.cwd(), "data", "candidate", "resume-facts.json");
}

export function resumesDir(): string {
  return process.env.JOBNOVA_RESUMES_DIR ?? path.resolve(process.cwd(), "data", "candidate", "resumes");
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const CITY_STATE = /\b([A-Z][a-z]+(?: [A-Z][a-z]+)*),\s*([A-Z]{2}|[A-Z][a-z]+)\b/;
const LABELED: Array<[RegExp, string]> = [
  [/^(full[\s-]?name|name)\s*:/i, "fullName"],
  [/^e-?mail\s*:/i, "email"],
  [/^(phone|mobile|tel|telephone)\s*:/i, "phone"],
  [/^(location|address|based in|lives in)\s*:/i, "currentLocation"],
  [/^(company|employer|current employer)\s*:/i, "currentCompany"],
  [/^(school|university|college)\s*:/i, "school"],
  [/^(degree|education)\s*:/i, "degree"],
  [/^(field|major|field of study)\s*:/i, "fieldOfStudy"],
];

const clean = (value: string): string => value.replace(/\s+/g, " ").trim();

function labeledFacts(lines: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of lines) {
    for (const [pattern, key] of LABELED) {
      if (pattern.test(line) && found[key] === undefined) {
        const value = clean(line.replace(pattern, ""));
        if (value) found[key] = value;
      }
    }
  }
  return found;
}

function looksLikeName(line: string): boolean {
  const words = line.split(" ");
  return words.length >= 2 && words.length <= 4
    && /[a-z]/.test(line)
    && /^[A-Za-z][A-Za-z .'-]*$/.test(line)
    && !/\d|@/.test(line);
}

/** Pulls trusted fact keys out of resume text. Explicit labels win over guesses. */
export function extractResumeFacts(text: string): Record<string, FactValue> {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const facts: Record<string, FactValue> = { ...labeledFacts(lines) };  const joined = lines.join("\n");
  if (!facts.email) {
    const match = joined.match(EMAIL);
    if (match) facts.email = match[0];
  }
  if (!facts.phone) {
    const match = joined.match(PHONE);
    if (match) facts.phone = match[0];
  }
  if (!facts.fullName) {
    const name = lines.find(looksLikeName);
    if (name) facts.fullName = name;
  }
  if (!facts.currentLocation) {
    const location = lines.slice(0, 15).map((line) => line.match(CITY_STATE)?.[0]).find(Boolean);
    if (location) facts.currentLocation = location;
  }
  const out: Record<string, FactValue> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (isTrustedCapability("fact", key) && typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

export async function loadResumeFacts(filePath: string = resumeFactsPath()): Promise<Record<string, FactValue>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const facts: Record<string, FactValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isTrustedCapability("fact", key) && typeof value === "string" && value.trim() !== "") facts[key] = value;
    }
    return facts;
  } catch {
    return {};
  }
}

export async function saveResumeFacts(facts: Record<string, FactValue>, filePath: string = resumeFactsPath()): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(facts, null, 2));
}

/**
 * Fills a live catalog from resume facts. The existing catalog always wins;
 * only missing keys are added. Mutates in place so running sessions pick
 * the facts up. Returns the keys that were added (for UI summaries).
 */
export function applyResumeFacts(catalog: CandidateFactCatalog, facts: Record<string, FactValue>, hasResumeFile: boolean): string[] {
  const added: string[] = [];
  const writable = catalog.facts as Record<string, FactValue>;
  for (const [key, value] of Object.entries(facts)) {
    if (!isTrustedCapability("fact", key) || typeof value !== "string" || value.trim() === "") continue;
    const current = writable[key];
    if (current === undefined || current === null || current === "") {
      writable[key] = value;
      added.push(key);
    }
  }
  if (hasResumeFile && !catalog.approvedResumeId) {
    (catalog as { approvedResumeId?: string }).approvedResumeId = "primary";
  }
  return added;
}