import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { SyntheticCandidateProfile } from "./profile.js";
import { createSyntheticProfile } from "./profile.js";

/** Ignored directory holding candidate resumes outside Git (see .gitignore). */
export const RESUME_DIR = path.resolve(process.cwd(), "data", "candidate", "resumes");
export const RESUME_FILE_NAME = "primary.pdf";

export const APPROVED_RESUME_IDS = ["primary"] as const;
export type ApprovedResumeId = (typeof APPROVED_RESUME_IDS)[number];

export type ApprovedResumeResolution =
  | { ok: true; filePath: string }
  | { ok: false; error: string };

/**
 * Resolves an approved resume identifier to an application-owned file.
 * The identifier must be in the fixed approved map; the file must exist and
 * be non-empty. Arbitrary paths are never accepted here, so the model can
 * never point the upload tool at an unapproved file.
 */
export function resolveApprovedResume(
  resumeId: string,
  resumeDir: string = RESUME_DIR,
  fileName: string = RESUME_FILE_NAME,
): ApprovedResumeResolution {
  if (!(APPROVED_RESUME_IDS as readonly string[]).includes(resumeId)) {
    return { ok: false, error: `Unapproved resume id "${resumeId}"; allowed ids: ${APPROVED_RESUME_IDS.join(", ")}` };
  }
  const filePath = path.resolve(resumeDir, fileName);
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0) {
      return { ok: false, error: `Approved resume file is missing or empty: ${filePath}` };
    }
  } catch {
    return { ok: false, error: `Approved resume file is missing: ${filePath}` };
  }
  return { ok: true, filePath };
}

/**
 * Generates a clearly synthetic one-page PDF resume with pdfkit. Content is
 * deterministic (fixed document metadata, no timestamps) and every line is
 * labelled fictional. The file lives under the Git-ignored data/candidate
 * directory.
 */
export async function generateSyntheticResume(
  filePath: string = path.join(RESUME_DIR, RESUME_FILE_NAME),
  profile: SyntheticCandidateProfile = createSyntheticProfile(),
): Promise<string> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: "Synthetic Test Resume (NOT a real candidate)",
      Author: "Job Agent application test",
      CreationDate: new Date("2026-01-01T00:00:00Z"),
      ModDate: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const writeStream = fs.createWriteStream(filePath);
  doc.pipe(writeStream);

  const line = (text: string, size = 11, gap = 14) => {
    doc.fontSize(size).text(text, { lineGap: gap - size });
  };

  doc.font("Helvetica-Bold").fontSize(18).text("SYNTHETIC TEST RESUME", { align: "center" });
  doc.moveDown(0.5);
  line("THIS DOCUMENT IS FICTIONAL TEST DATA FOR THE APPLICATION-AGENT TEST.", 10, 12);
  line("DO NOT USE IT FOR A REAL APPLICATION.", 10, 18);
  doc.moveDown();
  line(`Name: ${profile.fullName}`);
  line(`Email: ${profile.email}`);
  line(`Phone: ${profile.phone}`);
  doc.moveDown();
  line("Education", 13, 16);
  line("B.Sc. Data Science — Example University (fictional institution)", 10, 12);
  doc.moveDown();
  line("Employment", 13, 16);
  line("Junior Analyst — Example Corp (fictional employer)", 10, 12);
  doc.moveDown();
  line("Skills", 13, 16);
  line("Python, R, statistics, marketing analytics (fictional endorsements)", 10, 12);
  doc.moveDown();
  line("All identifying details in this document are synthetic.", 9, 12);

  await new Promise<void>((resolve, reject) => {
    doc.on("error", reject);
    writeStream.on("finish", () => resolve());
    doc.end();
  });
  return filePath;
}

/**
 * Ensures the approved synthetic resume exists, generating it if missing.
 * Returns the resolved path so the caller can fail fast before any browser
 * work when generation itself fails.
 */
export async function ensureSyntheticResume(): Promise<ApprovedResumeResolution> {
  const existing = resolveApprovedResume("primary");
  if (existing.ok) return existing;
  try {
    const filePath = await generateSyntheticResume();
    const resolved = resolveApprovedResume("primary");
    if (!resolved.ok) return { ok: false, error: `Resume generation produced an unreadable file: ${resolved.error}` };
    return resolved;
  } catch (error) {
    return { ok: false, error: `Could not generate the synthetic resume: ${error instanceof Error ? error.message : String(error)}` };
  }
}