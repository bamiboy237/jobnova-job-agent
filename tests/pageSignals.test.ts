import { describe, expect, it } from "vitest";
import {
  resolveExternalApplyUrl,
  selectCareersUrl,
  selectExactJobUrl,
} from "../src/resolver/pageSignals.js";

describe("deterministic page signals", () => {
  it("extracts the off-site URL from a LinkedIn external Apply redirect", () => {
    const target = "https://jobs.example.com/openings/123?source=linkedin";
    const redirect = `https://www.linkedin.com/jobs/view/externalApply/123?url=${encodeURIComponent(target)}`;
    expect(resolveExternalApplyUrl(redirect, "https://www.linkedin.com/jobs/view/123/")).toBe(target);
  });

  it("rejects ordinary LinkedIn and non-HTTPS Apply candidates", () => {
    expect(resolveExternalApplyUrl("https://www.linkedin.com/jobs/view/123/", "https://www.linkedin.com/jobs/view/123/")).toBe("");
    expect(resolveExternalApplyUrl("https://www.linkedin.com/jobs/view/externalApply/123", "https://www.linkedin.com/jobs/view/123/")).toBe("");
    expect(resolveExternalApplyUrl("http://jobs.example.com/123", "https://www.linkedin.com/jobs/view/123/")).toBe("");
  });

  it("selects one strongly labelled careers link", () => {
    expect(selectCareersUrl([
      { text: "About", url: "https://example.com/about" },
      { text: "Careers", url: "https://example.com/careers" },
      { text: "Careers", url: "https://example.com/careers/" },
    ], "https://example.com/")).toBe("https://example.com/careers");
  });

  it("leaves ambiguous careers choices to the model", () => {
    expect(selectCareersUrl([
      { text: "Careers", url: "https://example.com/careers" },
      { text: "Jobs", url: "https://example.com/jobs" },
    ], "https://example.com/")).toBe("");
  });

  it("ignores a careers self-link that differs only by trailing slash", () => {
    expect(selectCareersUrl([
      { text: "Careers", url: "https://example.com/careers" },
    ], "https://example.com/careers/")).toBe("");
  });

  it("selects one exact complete job title and rejects partial or ambiguous matches", () => {
    const title = "Software Engineer Intern, Internal Apps";
    expect(selectExactJobUrl([
      { text: title, url: "https://jobs.example.com/123" },
      { text: "Software Engineer Intern", url: "https://jobs.example.com/456" },
    ], title, "https://jobs.example.com/")).toBe("https://jobs.example.com/123");

    expect(selectExactJobUrl([
      { text: title, url: "https://jobs.example.com/123" },
      { text: `${title} Apply`, url: "https://jobs.example.com/456" },
    ], title, "https://jobs.example.com/")).toBe("");
  });
});
