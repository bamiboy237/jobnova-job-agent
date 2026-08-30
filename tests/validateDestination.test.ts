import { describe, it, expect } from "vitest";
import { validateDestination } from "../src/resolver/validateDestination.js";
import { isValidLinkedInJobUrl, ResolverInputSchema } from "../src/types.js";

describe("LinkedIn Input Validation", () => {
  it("accepts valid HTTPS LinkedIn job URLs with exact numeric ID", () => {
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/jobs/view/4460503117")).toBe(true);
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/jobs/view/4460503117/")).toBe(true);
    expect(isValidLinkedInJobUrl("https://linkedin.com/jobs/view/123456789?refId=abc#overview")).toBe(true);
  });

  it("rejects non-HTTPS URLs", () => {
    expect(isValidLinkedInJobUrl("http://www.linkedin.com/jobs/view/4460503117")).toBe(false);
  });

  it("rejects non-LinkedIn hosts and subdomains", () => {
    expect(isValidLinkedInJobUrl("https://example.com/jobs/view/4460503117")).toBe(false);
    expect(isValidLinkedInJobUrl("https://jobs.lever.co/company/123")).toBe(false);
    expect(isValidLinkedInJobUrl("https://sub.linkedin.com/jobs/view/4460503117")).toBe(false);
  });

  it("rejects non-numeric suffix or alphanumeric paths like /jobs/view/123abc", () => {
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/jobs/view/123abc")).toBe(false);
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/jobs/view/abc123")).toBe(false);
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/jobs/view/software-engineer-123")).toBe(false);
  });

  it("rejects non-job LinkedIn paths", () => {
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/feed")).toBe(false);
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/in/someuser")).toBe(false);
    expect(isValidLinkedInJobUrl("https://www.linkedin.com/company/salesforce")).toBe(false);
  });

  it("Zod schema rejects invalid URLs with helpful message", () => {
    const res = ResolverInputSchema.safeParse({ linkedinUrl: "https://example.com/jobs/123" });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.errors[0].message).toContain("HTTPS LinkedIn job URL");
    }
  });
});

describe("Destination Validation - Authentication & LinkedIn Rejection", () => {
  it("rejects LinkedIn login redirect", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Software Engineer",
      destinationUrl: "https://www.linkedin.com/login?fromSignIn=true",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("authentication/registration gate");
  });

  it("rejects LinkedIn cold-join signup gate", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Summer 2027 Intern - Software Engineer",
      destinationUrl: "https://www.linkedin.com/signup/cold-join?trk=public_jobs_apply-link-onsite_sign-up-modal",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("authentication/registration gate");
  });

  it("rejects LinkedIn authwall", () => {
    const result = validateDestination({
      company: "Google",
      jobTitle: "SWE",
      destinationUrl: "https://www.linkedin.com/authwall?trk=job",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("authentication/registration gate");
  });

  it("rejects LinkedIn checkpoint or challenge", () => {
    const result = validateDestination({
      company: "Google",
      jobTitle: "SWE",
      destinationUrl: "https://www.linkedin.com/checkpoint/challenge/abc",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("authentication/registration gate");
  });

  it("rejects standalone LinkedIn challenge and verification paths", () => {
    for (const destinationUrl of [
      "https://www.linkedin.com/challenge/abc",
      "https://www.linkedin.com/verification/abc",
    ]) {
      const result = validateDestination({
        company: "Google",
        jobTitle: "SWE",
        destinationUrl,
      });
      expect(result.isValid).toBe(false);
    }
  });

  it("rejects any destination remaining on LinkedIn", () => {
    const result = validateDestination({
      company: "Google",
      jobTitle: "SWE",
      destinationUrl: "https://www.linkedin.com/jobs/search",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("still on LinkedIn");
  });
});

describe("Destination Validation - Missing Identity Fields & Non-HTTPS", () => {
  it("rejects non-HTTPS destination URL", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Software Engineer",
      destinationUrl: "http://careers.salesforce.com/job/123",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "Salesforce",
        jobEvidence: "Software Engineer",
      },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("not HTTPS");
  });

  it("rejects when company name is empty", () => {
    const result = validateDestination({
      company: "",
      jobTitle: "Software Engineer",
      destinationUrl: "https://jobs.lever.co/ekimetrics/123",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("company name is missing");
  });

  it("rejects when job title is empty", () => {
    const result = validateDestination({
      company: "Ekimetrics",
      jobTitle: "",
      destinationUrl: "https://jobs.lever.co/ekimetrics/123",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("job title is missing");
  });
});

describe("Destination Validation - Negative Mismatch Tests", () => {
  it("rejects generic careers pages when pageType is careers", () => {
    const result = validateDestination({
      company: "Stripe",
      jobTitle: "Software Engineer",
      destinationUrl: "https://stripe.com/jobs/search",
      semanticEvaluation: {
        pageType: "careers",
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "Stripe Careers",
        jobEvidence: "Find software engineering jobs at Stripe",
      },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("generic careers page rather than a dedicated job opening");
  });

  it("rejects company homepage when pageType is homepage", () => {
    const result = validateDestination({
      company: "Stripe",
      jobTitle: "Software Engineer",
      destinationUrl: "https://stripe.com",
      semanticEvaluation: {
        pageType: "homepage",
        companyMatches: true,
        jobMatches: false,
        companyEvidence: "Stripe Financial Infrastructure",
        jobEvidence: "",
      },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("generic homepage page");
  });

  it("rejects Apple evaluated against Ekimetrics page", () => {
    const result = validateDestination({
      company: "Apple",
      jobTitle: "Hardware Engineer",
      destinationUrl: "https://jobs.lever.co/ekimetrics/d9d64766-3d42-4ba9-94d4-f74cdaf20065/apply",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: false,
        jobMatches: false,
        companyEvidence: "Ekimetrics",
        jobEvidence: "Data Consultant Intern",
      },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("does not match company \"Apple\"");
  });

  it("rejects Senior Software Engineer against the Salesforce Summer 2027 internship page", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Senior Software Engineer",
      destinationUrl: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/San-Francisco/Summer-2027-Intern---Software-Engineer_JR123",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: false,
        companyEvidence: "Salesforce",
        jobEvidence: "Summer 2027 Intern - Software Engineer",
      },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("does not match role \"Senior Software Engineer\"");
  });

  it("rejects semantic evaluation when jobMatches is false", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Senior Software Engineer",
      destinationUrl: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/San-Francisco/Summer-2027-Intern---Software-Engineer_JR123",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: false,
        companyEvidence: "Salesforce",
        jobEvidence: "Destination is for an internship role, not Senior Software Engineer",
      },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("does not match role \"Senior Software Engineer\"");
  });

  it("rejects semantic evaluation when evidence strings are empty", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Software Engineer",
      destinationUrl: "https://salesforce.wd12.myworkdayjobs.com/job/123",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "",
        jobEvidence: "Software Engineer",
      },
    });
    expect(result.isValid).toBe(false);
  });

  it("rejects when semantic destination validation is unavailable", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Summer 2027 Intern - Software Engineer",
      destinationUrl: "https://careers.salesforce.com/job/123",
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toContain("did not return evidence");
  });
});

describe("Destination Validation - Valid Matching Destinations", () => {
  it("validates Salesforce Workday destination matching company and role via semantic evaluation", () => {
    const result = validateDestination({
      company: "Salesforce",
      jobTitle: "Summer 2027 Intern - Software Engineer",
      destinationUrl: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/San-Francisco/Summer-2027-Intern---Software-Engineer_JR123",
      semanticEvaluation: {
        pageType: "job",
        companyMatches: true,
        jobMatches: true,
        companyEvidence: "Salesforce is a global leader in CRM",
        jobEvidence: "Role: Summer 2027 Intern - Software Engineer",
      },
    });
    expect(result.isValid).toBe(true);
    expect(result.evidence?.companyEvidence).toBe("Salesforce is a global leader in CRM");
    expect(result.evidence?.jobEvidence).toBe("Role: Summer 2027 Intern - Software Engineer");
  });
});
