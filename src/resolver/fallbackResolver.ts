import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type Stagehand } from "@browserbasehq/stagehand";
import { type Page } from "playwright-core";
import { type ResolverResult } from "../types.js";
import { checkLinkedInAuthWall, safeError } from "./browserSafety.js";
import { validateDestination, type DestinationSemanticEvaluation } from "./validateDestination.js";
import {
  readEmbeddedJobEvidence,
  readPageLinks,
  selectCareersUrl,
  selectExactJobUrl,
} from "./pageSignals.js";

const CompanyWebsiteSchema = z.object({
  companyWebsiteUrl: z.string().describe("Official HTTPS company website URL visible on the page, or empty string."),
  evidence: z.string().describe("Visible text proving the URL is the hiring company's official website, or empty string."),
  isOfficialWebsite: z.boolean().describe("True only when visible page evidence confirms the official website."),
});

const CompanyProfileDetailsSchema = z.object({
  actionToWebsiteDetails: z.string().describe("One visible action that opens the company About/details area where the official website is shown, or empty string."),
  evidence: z.string().describe("Visible evidence for that About/details control, or empty string."),
});

const CareersDiscoverySchema = z.object({
  pageType: z.enum(["homepage", "careers", "job", "other"]).describe("Type of the current page, not the proposed target."),
  companyMatches: z.boolean().describe("True only when visible current-page evidence matches the expected company."),
  careersUrl: z.string().describe("Visible HTTPS careers/jobs URL, or empty string."),
  actionToCareers: z.string().describe("One visible navigation action to careers/jobs, or empty string."),
  evidence: z.string().describe("Visible evidence for the company and careers destination, or empty string."),
});

const JobSearchSchema = z.object({
  pageType: z.enum(["careers", "job", "other"]).describe("Type of the current page."),
  companyMatches: z.boolean().describe("True when the current page or proposed exact-job target visibly belongs to the expected company."),
  jobMatches: z.boolean().describe("True when the current page or proposed exact-job target visibly matches the complete expected role."),
  jobListingUrl: z.string().describe("Visible HTTPS URL for one dedicated exact-job page, never a careers section anchor or search list, or empty string."),
  actionToOpenJob: z.string().describe("One visible action that opens the exact job, or empty string."),
  searchQuery: z.string().describe("Exact on-site search query if filtering is required, or empty string."),
  evidence: z.string().describe("Visible evidence for the company and exact role, or empty string."),
});

const FallbackValidationSchema = z.object({
  pageType: z.enum(["job", "careers", "homepage", "other"]),
  companyMatches: z.boolean(),
  jobMatches: z.boolean(),
  companyEvidence: z.string(),
  jobEvidence: z.string(),
});

export const MAX_FALLBACK_ACTIONS = 8;

export function isUsableCompanyWebsiteUrl(rawUrl: string, currentUrl: string): boolean {
  try {
    const candidate = new URL(rawUrl);
    const isLinkedIn = candidate.hostname === "linkedin.com" || candidate.hostname.endsWith(".linkedin.com");
    return candidate.protocol === "https:"
      && !isLinkedIn
      && normalizeFallbackUrl(candidate.href) !== normalizeFallbackUrl(currentUrl);
  } catch {
    return false;
  }
}

export function isLinkedInCompanyProfileUrl(rawUrl: string): boolean {
  try {
    const candidate = new URL(rawUrl);
    const isLinkedIn = candidate.hostname === "linkedin.com" || candidate.hostname.endsWith(".linkedin.com");
    return candidate.protocol === "https:" && isLinkedIn && candidate.pathname.startsWith("/company/");
  } catch {
    return false;
  }
}

export function normalizeFallbackUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.toString();
}

export function assessFallbackNavigation(input: {
  targetUrl: string;
  currentUrl: string;
  visitedUrls: ReadonlySet<string>;
  actionCount: number;
  maxActions?: number;
}): { ok: true; normalizedUrl: string } | { ok: false; reason: string } {
  if (input.actionCount >= (input.maxActions ?? MAX_FALLBACK_ACTIONS)) {
    return { ok: false, reason: `Fallback action limit of ${input.maxActions ?? MAX_FALLBACK_ACTIONS} reached` };
  }

  let normalizedUrl: string;
  try {
    const target = new URL(input.targetUrl);
    if (target.protocol !== "https:") {
      return { ok: false, reason: `Fallback destination is not HTTPS: ${input.targetUrl}` };
    }
    normalizedUrl = normalizeFallbackUrl(target.href);
  } catch {
    return { ok: false, reason: `Fallback destination is malformed: ${input.targetUrl}` };
  }

  let currentNormalized = "";
  try {
    currentNormalized = normalizeFallbackUrl(input.currentUrl);
  } catch {
    // The target is still checked against all previously verified URLs.
  }

  if (normalizedUrl === currentNormalized) {
    return { ok: false, reason: `Fallback navigation made no URL progress: ${input.targetUrl}` };
  }
  if (input.visitedUrls.has(normalizedUrl)) {
    return { ok: false, reason: `Fallback navigation repeated a visited URL: ${input.targetUrl}` };
  }
  return { ok: true, normalizedUrl };
}

class FallbackBlocker extends Error {}

async function captureSafeScreenshot(page: Page, targetPath: string): Promise<string | null> {
  try {
    await page.screenshot({ path: targetPath, timeout: 5000 });
    const stat = await fs.stat(targetPath);
    return stat.size > 0 ? targetPath : null;
  } catch {
    return null;
  }
}

async function pageFingerprint(page: Page): Promise<string> {
  const frameState = await Promise.all(page.frames().map(async (frame) => {
    const isMainFrame = frame === page.mainFrame();
    const isVisible = isMainFrame || await frame.frameElement()
      .then((element) => element.isVisible())
      .catch(() => false);
    if (!isVisible) return "";
    const text = await frame.evaluate((useBodyFallback) => ({
      title: document.title,
      heading: document.querySelector("h1")?.textContent || "",
      main: (document.querySelector("main")?.textContent || (useBodyFallback ? document.body?.innerText : "") || "").slice(0, 20000),
    }), true).catch(() => ({ title: "", heading: "", main: "" }));
    if (!isMainFrame && !text.heading.trim() && !text.main.trim()) return "";
    return `${frame.url()}\n${text.title}\n${text.heading}\n${text.main}`;
  }));
  return createHash("sha256").update(frameState.filter(Boolean).join("\n---\n")).digest("hex");
}

export interface FallbackOptions {
  stagehand: Stagehand;
  company: string;
  jobTitle: string;
  location?: string;
  companyProfileUrl?: string;
  linkedinUrl: string;
  trace: string[];
  screenshots: string[];
  screenshotsDir: string;
  startTime: number;
  secrets?: string[];
}

export async function resolveCompanySiteFallback(options: FallbackOptions): Promise<ResolverResult> {
  const { stagehand, company, jobTitle, location, linkedinUrl, trace, screenshots, screenshotsDir, startTime } = options;
  const page = stagehand.page;
  const visitedUrls = new Set<string>([normalizeFallbackUrl(linkedinUrl)]);
  let actionCount = 0;
  let furthestVerifiedUrl = linkedinUrl;

  const consumeAction = () => {
    if (actionCount >= MAX_FALLBACK_ACTIONS) {
      throw new FallbackBlocker(`Fallback action limit of ${MAX_FALLBACK_ACTIONS} reached`);
    }
    actionCount += 1;
  };

  const verifyCurrentPage = async () => {
    if (await checkLinkedInAuthWall(page)) {
      throw new FallbackBlocker("LinkedIn authentication or verification barrier encountered during fallback");
    }
    const current = new URL(page.url());
    if (current.protocol !== "https:") {
      throw new FallbackBlocker(`Fallback navigation reached a non-HTTPS page: ${page.url()}`);
    }
  };

  const navigateTo = async (targetUrl: string, label: string) => {
    const assessment = assessFallbackNavigation({
      targetUrl,
      currentUrl: page.url(),
      visitedUrls,
      actionCount,
    });
    if (!assessment.ok) throw new FallbackBlocker(assessment.reason);
    consumeAction();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator("body").waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => (
      (document.querySelector("main")?.textContent || document.body?.innerText || "").trim().length >= 200
      || document.querySelector("iframe") !== null
    ), { timeout: 8000 }).catch(() => {});
    await verifyCurrentPage();

    const actualNormalized = normalizeFallbackUrl(page.url());
    if (visitedUrls.has(actualNormalized)) {
      throw new FallbackBlocker(`Fallback navigation repeated a visited URL: ${page.url()}`);
    }
    visitedUrls.add(actualNormalized);
    furthestVerifiedUrl = page.url();
    trace.push(`${label}: ${furthestVerifiedUrl}`);
  };

  const actWithProgress = async (action: string, label: string) => {
    consumeAction();
    const beforeUrl = page.url();
    const beforeFingerprint = await pageFingerprint(page);
    const popupCapture: { page: Page | null } = { page: null };
    const context = page.context();
    const recordPopup = (newPage: Page) => {
      popupCapture.page ??= newPage;
    };
    context.on("page", recordPopup);
    try {
      await stagehand.act({ action });
    } finally {
      context.off("page", recordPopup);
    }

    const popup = popupCapture.page;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      const popupUrl = popup.url();
      await popup.close().catch(() => {});
      if (!popupUrl) throw new FallbackBlocker(`${label} opened a page without a URL`);
      const assessment = assessFallbackNavigation({
        targetUrl: popupUrl,
        currentUrl: beforeUrl,
        visitedUrls,
        actionCount: actionCount - 1,
      });
      if (!assessment.ok) throw new FallbackBlocker(assessment.reason);
      await page.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await verifyCurrentPage();
    const afterFingerprint = await pageFingerprint(page);
    if (afterFingerprint === beforeFingerprint) {
      throw new FallbackBlocker(`${label} made no observable progress`);
    }

    if (page.url() !== beforeUrl) {
      const actualNormalized = normalizeFallbackUrl(page.url());
      if (visitedUrls.has(actualNormalized)) {
        throw new FallbackBlocker(`Fallback navigation repeated a visited URL: ${page.url()}`);
      }
      visitedUrls.add(actualNormalized);
      furthestVerifiedUrl = page.url();
    }
    trace.push(`${label}: ${page.url()}`);
  };

  const capture = async (name: string, embeddedHeading?: string) => {
    const screenshotPath = path.join(screenshotsDir, `${name}_${Date.now()}.png`);
    if (embeddedHeading) {
      for (const frame of page.frames()) {
        const headings = frame.locator("h1, h2");
        const count = await headings.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const heading = headings.nth(index);
          const text = await heading.textContent().catch(() => "");
          if (text?.trim() !== embeddedHeading) continue;
          const evidencePage = await page.context().newPage().catch(() => null);
          if (!evidencePage) continue;
          try {
            await evidencePage.goto(frame.url(), { waitUntil: "domcontentloaded", timeout: 15000 });
            await evidencePage.locator("h1, h2").filter({ hasText: embeddedHeading }).first()
              .waitFor({ state: "visible", timeout: 8000 });
            const saved = await captureSafeScreenshot(evidencePage, screenshotPath);
            if (saved) screenshots.push(saved);
            if (saved) return;
          } catch {
            // Fall back to a page screenshot below.
          } finally {
            await evidencePage.close().catch(() => {});
          }
        }
      }
    }
    const saved = await captureSafeScreenshot(page, screenshotPath);
    if (saved) screenshots.push(saved);
  };

  try {
    trace.push("Initiating company-site fallback resolution");
    await verifyCurrentPage();

    trace.push(`Discovering official website for company "${company}" from LinkedIn`);
    let website = await stagehand.extract({
      instruction: `Current page: ${page.url()}\nKnown hiring company: "${company}"\nKnown complete job title: "${jobTitle}"\nImmediate goal: identify an official company-owned HTTPS website URL visibly supported by this LinkedIn listing.\nDo not guess a domain from memory. Do not sign in or apply. Return empty strings and isOfficialWebsite=false when visible evidence is absent.`,
      schema: CompanyWebsiteSchema,
    });

    if (!website.isOfficialWebsite || !website.evidence.trim() || !isUsableCompanyWebsiteUrl(website.companyWebsiteUrl.trim(), page.url())) {
      const companyPageUrl = (options.companyProfileUrl && isLinkedInCompanyProfileUrl(options.companyProfileUrl))
        ? options.companyProfileUrl
        : await page.evaluate((expectedCompany) => {
        const expected = expectedCompany.toLowerCase();
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/company/']"));
        for (const link of links) {
          const text = (link.textContent || "").trim().toLowerCase();
          const aria = (link.getAttribute("aria-label") || "").trim().toLowerCase();
          if ((text && (text.includes(expected) || expected.includes(text))) || aria.includes(expected)) {
            const clean = link.href.split("?")[0].replace(/\/(life|jobs)\/?$/, "/");
            try {
              const candidate = new URL(clean);
              if (!candidate.pathname.startsWith("/company/")) continue;
            } catch {
              continue;
            }
            return clean.endsWith("/") ? clean : `${clean}/`;
          }
        }
        return "";
      }, company);

      if (!isLinkedInCompanyProfileUrl(companyPageUrl)) {
        throw new FallbackBlocker(`Could not find the LinkedIn company profile for "${company}"`);
      }
      await navigateTo(companyPageUrl, "Opened LinkedIn company profile");
      website = await stagehand.extract({
        instruction: `Current page: ${page.url()}\nKnown hiring company: "${company}"\nKnown complete job title: "${jobTitle}"\nImmediate goal: extract the official company-owned HTTPS website URL visibly shown on this LinkedIn company profile.\nDo not guess from memory. Do not select advertisements, social profiles, or unrelated external links. Return empty strings and isOfficialWebsite=false when visible evidence is absent.`,
        schema: CompanyWebsiteSchema,
      });

      if (!website.isOfficialWebsite || !website.evidence.trim() || !isUsableCompanyWebsiteUrl(website.companyWebsiteUrl.trim(), page.url())) {
        const details = await stagehand.extract({
          instruction: `Current page: ${page.url()}\nKnown hiring company: "${company}"\nImmediate goal: identify one visible About/details control that opens company information where the official website is shown.\nDo not guess a URL, leave LinkedIn, sign in, or apply. Return empty fields when no supported control is visible.`,
          schema: CompanyProfileDetailsSchema,
        });
        if (!details.actionToWebsiteDetails.trim() || !details.evidence.trim()) {
          throw new FallbackBlocker(`Could not find visible company details for "${company}" on LinkedIn`);
        }
        await actWithProgress(
          `Known company: "${company}". Open only the visible LinkedIn company About/details control described as: ${details.actionToWebsiteDetails}. Do not leave LinkedIn or sign in.`,
          "Opened LinkedIn company details",
        );
        website = await stagehand.extract({
          instruction: `Current page: ${page.url()}\nKnown hiring company: "${company}"\nKnown complete job title: "${jobTitle}"\nImmediate goal: extract the official company-owned HTTPS website URL visibly shown in these LinkedIn company details.\nDo not guess from memory. Do not select advertisements, social profiles, or unrelated links. Return empty strings and isOfficialWebsite=false when visible evidence is absent.`,
          schema: CompanyWebsiteSchema,
        });
      }
    }

    const companyWebsiteUrl = website.companyWebsiteUrl.trim();
    if (!website.isOfficialWebsite || !website.evidence.trim() || !isUsableCompanyWebsiteUrl(companyWebsiteUrl, page.url())) {
      throw new FallbackBlocker(`Could not verify the official website for "${company}" from visible LinkedIn evidence`);
    }
    await navigateTo(companyWebsiteUrl, "Opened verified company website");
    await capture("company");

    const currentPath = new URL(page.url()).pathname.toLowerCase();
    const alreadyInCareersArea = /\/(careers?|jobs?)(\/|$)/.test(currentPath);
    const deterministicCareersUrl = alreadyInCareersArea ? "" : selectCareersUrl(await readPageLinks(page), page.url());
    if (alreadyInCareersArea) {
      trace.push(`Verified company website is already the careers area: ${page.url()}`);
    } else if (deterministicCareersUrl) {
      trace.push("Found an unambiguous careers link in page data");
      await navigateTo(deterministicCareersUrl, "Opened careers area");
    } else {
      const careers = await stagehand.extract({
        instruction: `Current page: ${page.url()}\nKnown hiring company: "${company}"\nKnown complete job title: "${jobTitle}"\nImmediate goal: select one visible link or action that opens this company's careers or jobs area.\nAllowed action: navigate only to careers/jobs. Do not sign in, apply, submit forms, or open an unrelated job. Do not claim a generic page is the final job result. Return empty URL/action, false matches, and empty evidence when unsupported.`,
        schema: CareersDiscoverySchema,
      });
      if (!careers.companyMatches || !careers.evidence.trim()) {
        throw new FallbackBlocker(`Could not verify a careers path for "${company}" from visible evidence`);
      }
      if (careers.careersUrl.trim()) {
        await navigateTo(careers.careersUrl.trim(), "Opened careers area");
      } else if (careers.actionToCareers.trim()) {
        await actWithProgress(
          `Known company: "${company}". Click only the visible careers/jobs control described as: ${careers.actionToCareers}. Do not sign in or submit forms.`,
          "Opened careers area",
        );
      } else {
        throw new FallbackBlocker(`No supported careers navigation was found for "${company}"`);
      }
    }
    await capture("careers");

    const extractJobChoice = () => stagehand.extract({
      instruction: `Current page: ${page.url()}\nKnown hiring company: "${company}"\nRequired complete job title: "${jobTitle}"${location ? `\nLinkedIn location evidence: "${location}"` : ""}\nImmediate goal: identify the dedicated page for this exact opening. Distinguish seniority, internship status, season, year, team, and location. Shared generic words are insufficient.\nAllowed actions: select one visible exact-job URL/action, or provide one on-site search query. jobListingUrl must identify one dedicated job page; never return a careers page, section anchor, category, or search list. Do not apply, sign in, or submit forms. Do not guess URLs or facts. Return empty fields and false matches when visible evidence is insufficient.`,
      schema: JobSearchSchema,
    });

    await page.locator("a[href] h1, a[href] h2, a[href] h3, a[href] h4")
      .first()
      .waitFor({ state: "attached", timeout: 8000 })
      .catch(() => {});
    const deterministicJobUrl = selectExactJobUrl(await readPageLinks(page), jobTitle, page.url());
    let jobChoice: z.infer<typeof JobSearchSchema>;
    if (deterministicJobUrl) {
      trace.push("Found an unambiguous exact-title job link in page data");
      if (normalizeFallbackUrl(deterministicJobUrl) !== normalizeFallbackUrl(page.url())) {
        await navigateTo(deterministicJobUrl, "Opened exact job page");
      }
      jobChoice = {
        pageType: "job",
        companyMatches: true,
        jobMatches: true,
        jobListingUrl: deterministicJobUrl,
        actionToOpenJob: "",
        searchQuery: "",
        evidence: jobTitle,
      };
    } else {
      jobChoice = await extractJobChoice();
    }
    if (jobChoice.pageType !== "job" || !jobChoice.jobMatches) {
      if (jobChoice.jobListingUrl.trim()) {
        if (!jobChoice.companyMatches || !jobChoice.jobMatches || !jobChoice.evidence.trim()) {
          throw new FallbackBlocker(`The proposed job URL lacks exact company and role evidence`);
        }
        await navigateTo(jobChoice.jobListingUrl.trim(), "Opened exact job page");
      } else if (jobChoice.actionToOpenJob.trim()) {
        if (!jobChoice.companyMatches || !jobChoice.jobMatches || !jobChoice.evidence.trim()) {
          throw new FallbackBlocker(`The proposed job action lacks exact company and role evidence`);
        }
        await actWithProgress(
          `Known company: "${company}". Exact job: "${jobTitle}". ${jobChoice.actionToOpenJob}. Do not apply or submit forms.`,
          "Opened exact job page",
        );
      } else if (jobChoice.searchQuery.trim()) {
        await actWithProgress(
          `Use the careers site's visible job search to search exactly for "${jobChoice.searchQuery}". Do not apply or submit forms.`,
          "Filtered careers jobs",
        );
        jobChoice = await extractJobChoice();
        if (jobChoice.jobListingUrl.trim() && jobChoice.companyMatches && jobChoice.jobMatches && jobChoice.evidence.trim()) {
          await navigateTo(jobChoice.jobListingUrl.trim(), "Opened exact job page");
        } else if (jobChoice.actionToOpenJob.trim() && jobChoice.companyMatches && jobChoice.jobMatches && jobChoice.evidence.trim()) {
          await actWithProgress(
            `Known company: "${company}". Click only the exact job "${jobTitle}" using this visible action: ${jobChoice.actionToOpenJob}. Do not apply.`,
            "Opened exact job page",
          );
        } else if (jobChoice.pageType !== "job" || !jobChoice.jobMatches) {
          throw new FallbackBlocker(`On-site search did not produce the exact job "${jobTitle}"`);
        }
      } else {
        throw new FallbackBlocker(`Could not find the exact job "${jobTitle}" from the careers area`);
      }
    }

    await verifyCurrentPage();
    const finalDestinationUrl = page.url();
    trace.push(`Validating final fallback destination: ${finalDestinationUrl}`);
    const embeddedEvidence = await readEmbeddedJobEvidence(page, jobTitle);
    await capture("destination", embeddedEvidence?.heading);

    let semanticEvaluation: DestinationSemanticEvaluation | undefined;
    try {
      semanticEvaluation = await stagehand.extract({
        instruction: `Current page: ${finalDestinationUrl}\nExpected hiring company: "${company}"\nExpected complete job title: "${jobTitle}"${location ? `\nLinkedIn location evidence: "${location}"` : ""}${embeddedEvidence ? `\nVisible embedded job heading: "${embeddedEvidence.heading}"\nVisible embedded job text excerpt:\n${embeddedEvidence.text}` : ""}\nDetermine whether this is a page dedicated to one exact job opening. Embedded application content is part of the current visible page. A homepage, careers list, search result, category page, or generic application page is not pageType="job". Distinguish seniority, internship status, season, year, team, and location. Quote visible company and complete-title evidence. Return false matches and empty evidence when unsupported; never infer from the URL, ATS brand, or model memory.`,
        schema: FallbackValidationSchema,
      });
    } catch (error) {
      trace.push(`Final fallback validation error: ${safeError(error, options.secrets)}`);
    }

    const validation = validateDestination({ company, jobTitle, destinationUrl: finalDestinationUrl, semanticEvaluation });
    if (!validation.isValid) {
      return {
        success: false,
        company,
        jobTitle,
        linkedinUrl,
        externalJobUrl: finalDestinationUrl,
        error: validation.reason || "Fallback destination failed validation",
        runtimeMs: Date.now() - startTime,
        trace: [...trace, `Fallback destination validation failed: ${validation.reason}`],
        screenshots,
      };
    }

    trace.push(`Validated fallback destination matches company and job (Evidence: ${validation.evidence?.companyEvidence} | ${validation.evidence?.jobEvidence})`);
    return {
      success: true,
      company,
      jobTitle,
      linkedinUrl,
      externalJobUrl: finalDestinationUrl,
      runtimeMs: Date.now() - startTime,
      trace,
      screenshots,
    };
  } catch (error) {
    const message = safeError(error, options.secrets);
    trace.push(`Company-site fallback stopped: ${message}`);
    let externalJobUrl: string | undefined;
    try {
      const furthest = new URL(furthestVerifiedUrl);
      const isLinkedIn = furthest.hostname === "linkedin.com" || furthest.hostname.endsWith(".linkedin.com");
      if (!isLinkedIn && furthest.protocol === "https:") externalJobUrl = furthest.href;
    } catch {
      // Leave externalJobUrl absent when the furthest page is not a valid external URL.
    }
    return {
      success: false,
      company,
      jobTitle,
      linkedinUrl,
      externalJobUrl,
      error: message,
      runtimeMs: Date.now() - startTime,
      trace,
      screenshots,
    };
  }
}
