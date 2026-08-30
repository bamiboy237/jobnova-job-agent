import { describe, it, expect } from "vitest";
import { validateDestination } from "../src/resolver/validateDestination.js";
import {
  assessFallbackNavigation,
  isUsableCompanyWebsiteUrl,
  isLinkedInCompanyProfileUrl,
  MAX_FALLBACK_ACTIONS,
  normalizeFallbackUrl,
} from "../src/resolver/fallbackResolver.js";
import { shouldEnterCompanySiteFallback } from "../src/resolver/directResolver.js";
import { safeError } from "../src/resolver/browserSafety.js";

describe("Fallback Resolver - Deterministic Rules & Validation", () => {
  it("removes secrets and browser connection URLs from fallback errors", () => {
    const message = safeError(
      new Error("key=secret-value wss://connect.example/token https://www.browserbase.com/sessions/session-id"),
      ["secret-value"],
    );
    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("connect.example");
    expect(message).not.toContain("session-id");
  });

  it("enters fallback for missing, LinkedIn, auth-gated, or unvalidated direct destinations", () => {
    const linkedinUrl = "https://www.linkedin.com/jobs/view/123/";
    expect(shouldEnterCompanySiteFallback({ directDestinationUrl: "", linkedinUrl, isAuthGate: false, validationSucceeded: false })).toBe(true);
    expect(shouldEnterCompanySiteFallback({ directDestinationUrl: linkedinUrl, linkedinUrl, isAuthGate: false, validationSucceeded: false })).toBe(true);
    expect(shouldEnterCompanySiteFallback({ directDestinationUrl: "https://www.linkedin.com/signup", linkedinUrl, isAuthGate: true, validationSucceeded: false })).toBe(true);
    expect(shouldEnterCompanySiteFallback({ directDestinationUrl: "https://jobs.example.com/wrong-role", linkedinUrl, isAuthGate: false, validationSucceeded: false })).toBe(true);
    expect(shouldEnterCompanySiteFallback({ directDestinationUrl: "https://jobs.example.com/exact-role", linkedinUrl, isAuthGate: false, validationSucceeded: true })).toBe(false);
  });

  it("rejects malformed, non-HTTPS, repeated, and no-progress fallback URLs", () => {
    const currentUrl = "https://example.com/careers";
    const visitedUrls = new Set([normalizeFallbackUrl("https://example.com/jobs?id=1")]);
    expect(assessFallbackNavigation({ targetUrl: "not a url", currentUrl, visitedUrls, actionCount: 0 }).ok).toBe(false);
    expect(assessFallbackNavigation({ targetUrl: "http://example.com/jobs", currentUrl, visitedUrls, actionCount: 0 }).ok).toBe(false);
    expect(assessFallbackNavigation({ targetUrl: currentUrl, currentUrl, visitedUrls, actionCount: 0 }).ok).toBe(false);
    expect(assessFallbackNavigation({ targetUrl: "https://example.com/jobs?id=1", currentUrl, visitedUrls, actionCount: 0 }).ok).toBe(false);
  });

  it("rejects LinkedIn, non-HTTPS, malformed, and current-page company website candidates", () => {
    const currentUrl = "https://www.linkedin.com/jobs/view/123/";
    expect(isUsableCompanyWebsiteUrl(currentUrl, currentUrl)).toBe(false);
    expect(isUsableCompanyWebsiteUrl("https://www.linkedin.com/company/acme/", currentUrl)).toBe(false);
    expect(isUsableCompanyWebsiteUrl("http://acme.example/", currentUrl)).toBe(false);
    expect(isUsableCompanyWebsiteUrl("not a url", currentUrl)).toBe(false);
    expect(isUsableCompanyWebsiteUrl("https://acme.example/", currentUrl)).toBe(true);
  });

  it("accepts only LinkedIn company profile paths for profile navigation", () => {
    expect(isLinkedInCompanyProfileUrl("https://www.linkedin.com/company/acme/")).toBe(true);
    expect(isLinkedInCompanyProfileUrl("https://www.linkedin.com/jobs/view/123/")).toBe(false);
    expect(isLinkedInCompanyProfileUrl("https://example.com/company/acme/")).toBe(false);
    expect(isLinkedInCompanyProfileUrl("not a url")).toBe(false);
  });

  it("preserves query-based job identifiers and enforces the action limit", () => {
    expect(normalizeFallbackUrl("https://example.com/jobs?gh_jid=1")).not.toBe(
      normalizeFallbackUrl("https://example.com/jobs?gh_jid=2"),
    );
    const result = assessFallbackNavigation({
      targetUrl: "https://example.com/jobs?gh_jid=2",
      currentUrl: "https://example.com/careers",
      visitedUrls: new Set(),
      actionCount: MAX_FALLBACK_ACTIONS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("action limit");
  });

  it("treats a visible section anchor as progress without hardcoding its name", () => {
    const currentUrl = "https://example.com/careers/";
    const targetUrl = "https://example.com/careers/#jobs-section";
    expect(normalizeFallbackUrl(currentUrl)).not.toBe(normalizeFallbackUrl(targetUrl));
    expect(assessFallbackNavigation({
      targetUrl,
      currentUrl,
      visitedUrls: new Set([normalizeFallbackUrl(currentUrl)]),
      actionCount: 1,
    }).ok).toBe(true);
  });

  it("rejects final validation when pageType is missing", () => {
    const result = validateDestination({
      company: "Acme",
      jobTitle: "Software Engineer",
      destinationUrl: "https://jobs.acme.com/123",
      semanticEvaluation: {
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "Acme",
        jobEvidence: "Software Engineer",
      } as never,
    });
    expect(result.isValid).toBe(false);
  });

  it("rejects generic careers page as externalJobUrl during fallback", () => {
    const result = validateDestination({
      company: "Datadog",
      jobTitle: "Software Engineer - Backend",
      destinationUrl: "https://careers.datadoghq.com",
      semanticEvaluation: {
        pageType: "careers",
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "Datadog Careers",
        jobEvidence: "Software Engineer openings at Datadog",
      },
    });

    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("generic careers page");
  });

  it("rejects unrelated job result from search list", () => {
    const result = validateDestination({
      company: "Datadog",
      jobTitle: "Software Engineer - Backend",
      destinationUrl: "https://careers.datadoghq.com/detail/123",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: false,
        companyEvidence: "Datadog, Inc.",
        jobEvidence: "Found position: Product Marketing Manager",
      },
    });

    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("does not match role \"Software Engineer - Backend\"");
  });

  it("rejects candidate company URL when missing evidence or not HTTPS", () => {
    const nonHttps = validateDestination({
      company: "Acme",
      jobTitle: "DevOps Engineer",
      destinationUrl: "http://careers.acme.com/jobs/123",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "Acme",
        jobEvidence: "DevOps Engineer",
      },
    });
    expect(nonHttps.isValid).toBe(false);
    expect(nonHttps.reason).toContain("not HTTPS");
  });

  it("accepts confirmed single-job posting matching company and exact role", () => {
    const result = validateDestination({
      company: "Datadog",
      jobTitle: "Software Engineer - Backend",
      destinationUrl: "https://careers.datadoghq.com/detail/software-engineer-backend-456",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "Datadog is the monitoring and security platform for cloud applications",
        jobEvidence: "Role Title: Software Engineer - Backend (Full-Time)",
      },
    });

    expect(result.isValid).toBe(true);
    expect(result.evidence?.companyEvidence).toContain("Datadog");
    expect(result.evidence?.jobEvidence).toContain("Software Engineer - Backend");
  });
});
