import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { generateSyntheticResume } from "../src/apply/resume.js";
import { applyResumeFacts, extractResumeFacts, loadResumeFacts, saveResumeFacts } from "../src/apply/resumeFacts.js";
import type { CandidateFactCatalog } from "../src/apply/generalFacts.js";

const LABELED = [
  "SYNTHETIC TEST RESUME",
  "Name: Jordan Casey",
  "Email: jordan.casey@example.com",
  "Phone: +1 (555) 019-2834",
  "Location: Austin, TX",
  "Experience",
  "Senior Analyst — Example Corp",
].join("\n");

describe("resume facts", () => {
  it("reads labeled lines first", () => {
    expect(extractResumeFacts(LABELED)).toMatchObject({
      fullName: "Jordan Casey",
      email: "jordan.casey@example.com",
      phone: "+1 (555) 019-2834",
      currentLocation: "Austin, TX",
    });
  });

  it("guesses name, contact, and city from unlabeled text", () => {
    const text = ["Jordan Casey", "Austin, TX", "jordan.casey@example.com", "(555) 019-2834", "Experience", "Senior Analyst"].join("\n");
    expect(extractResumeFacts(text)).toMatchObject({
      fullName: "Jordan Casey",
      email: "jordan.casey@example.com",
      currentLocation: "Austin, TX",
    });
  });

  it("skips shouting headers and keeps only trusted keys", () => {
    const facts = extractResumeFacts(["JORDAN CASEY CV", "Hacker: yes", "jordan@example.com"].join("\n"));
    expect(facts.fullName).toBeUndefined();
    expect(facts).toMatchObject({ email: "jordan@example.com" });
    expect("Hacker" in facts || "hacker" in facts).toBe(false);
  });

  it("round-trips through disk and drops untrusted keys", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-facts-"));
    const file = path.join(dir, "resume-facts.json");
    await saveResumeFacts({ email: "jordan@example.com", evil: "x" }, file);
    expect(await loadResumeFacts(file)).toEqual({ email: "jordan@example.com" });
  });

  it("reads nothing when the file is missing or corrupt", async () => {
    expect(await loadResumeFacts(path.join(os.tmpdir(), `nope-${Date.now()}.json`))).toEqual({});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-facts-"));
    const file = path.join(dir, "resume-facts.json");
    await fs.writeFile(file, "{oops");
    expect(await loadResumeFacts(file)).toEqual({});
  });

  it("fills gaps only and reports added keys", () => {
    const catalog: CandidateFactCatalog = { facts: { email: "kept@example.com" }, reusableAnswers: {} };
    const added = applyResumeFacts(catalog, { email: "new@example.com", phone: "555-0100" }, true);
    expect(catalog.facts).toMatchObject({ email: "kept@example.com", phone: "555-0100" });
    expect(added).toEqual(["phone"]);
    expect(catalog.approvedResumeId).toBe("primary");
  });

  it("leaves the resume id alone without a file", () => {
    const catalog: CandidateFactCatalog = { facts: {}, reusableAnswers: {} };
    applyResumeFacts(catalog, { email: "jordan@example.com" }, false);
    expect(catalog.approvedResumeId).toBeUndefined();
  });

  it("parses a real generated PDF end to end", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-pdf-"));
    const file = path.join(dir, "resume.pdf");
    await generateSyntheticResume(file);
    const parser = new PDFParse({ data: await fs.readFile(file) });
    const parsed = await parser.getText();
    await parser.destroy();
    expect(extractResumeFacts(parsed.text)).toMatchObject({
      fullName: "Taylor Alex Sample",
      email: "taylor.sample@example.com",
    });
  }, 30000);
});