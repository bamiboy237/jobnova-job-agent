import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { candidateProfileToCatalog } from "../src/apply/candidateCatalog.js";
import { createSyntheticProfile, loadCandidateProfile } from "../src/apply/profile.js";
import { resolveApprovedResume } from "../src/apply/resume.js";

describe("general application inputs", () => {
  it("converts only trusted candidate facts", () => {
    const profile = createSyntheticProfile();
    const catalog = candidateProfileToCatalog({ ...profile, extra: "no" } as never);
    expect(catalog.facts).toMatchObject({ firstName: "Taylor", lastName: "Alex Sample", phoneDigits: "5550104242" });
    expect(catalog.facts).toHaveProperty("email");
    expect(catalog.facts).not.toHaveProperty("isSynthetic");
    expect(catalog.facts).not.toHaveProperty("extra");
    expect(catalog.approvedResumeId).toBe("primary");
  });
  it("loads complete private input and rejects incomplete input", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-"));
    const valid = path.join(dir, "valid.json"); fs.writeFileSync(valid, JSON.stringify({ ...createSyntheticProfile(), isSynthetic: false })); expect((await loadCandidateProfile(valid)).ok).toBe(true);
    const bad = path.join(dir, "bad.json"); fs.writeFileSync(bad, "{}"); expect((await loadCandidateProfile(bad)).ok).toBe(false); fs.rmSync(dir, { recursive: true });
  });
  it("keeps resume resolution app-owned", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-")); expect(resolveApprovedResume("../../x", dir).ok).toBe(false); expect(resolveApprovedResume("primary", dir).ok).toBe(false); fs.writeFileSync(path.join(dir, "primary.pdf"), ""); expect(resolveApprovedResume("primary", dir).ok).toBe(false);
    fs.writeFileSync(path.join(dir, "primary.pdf"), "pdf"); expect(resolveApprovedResume("primary", dir)).toMatchObject({ ok: true }); fs.rmSync(dir, { recursive: true });
  });
});
