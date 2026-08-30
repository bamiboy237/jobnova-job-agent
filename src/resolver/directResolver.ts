import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Stagehand } from "@browserbasehq/stagehand";
import { type Page } from "playwright-core";
import { getStagehandModelConfig } from "../llm/stagehandModel.js";
import {
  ResolverInputSchema,
  type ResolverInput,
  type ResolverResult,
} from "../types.js";
import { validateDestination } from "./validateDestination.js";
import { resolveCompanySiteFallback } from "./fallbackResolver.js";
import { checkLinkedInAuthWall, safeError } from "./browserSafety.js";
import { loadLocalBrowserCookies, LOCAL_CHROME_PATH, saveLocalBrowserState } from "../browser/session.js";
import { readLinkedInListingSignals } from "./pageSignals.js";

const LinkedInIdentitySchema = z.object({
  company: z.string().min(1, "Company cannot be empty").describe("The hiring company offering the job"),
  jobTitle: z.string().min(1, "Job title cannot be empty").describe("The job title or role on the listing"),
  location: z.string().describe("Visible job location (city, state, country, or remote) or empty string"),
});

const DestinationIdentitySchema = z.object({
  pageType: z
    .enum(["job", "careers", "homepage", "other"])
    .describe("Set to 'job' ONLY if this page is dedicated to one single job opening"),
  companyMatches: z.boolean().describe("True only if this page is for the expected hiring company"),
  jobMatches: z.boolean().describe("True only if this page is for the exact expected job title/role (distinguishing seniority and internship terms)"),
  companyEvidence: z.string().describe("Direct quote of visible evidence matching the company on the page"),
  jobEvidence: z.string().describe("Direct quote of visible evidence matching the exact job title/role on the page"),
});

export function shouldEnterCompanySiteFallback(input: {
  directDestinationUrl: string;
  linkedinUrl: string;
  isAuthGate: boolean;
  validationSucceeded: boolean;
}): boolean {
  if (input.validationSucceeded) return false;
  if (input.isAuthGate || !input.directDestinationUrl) return true;
  try {
    const destination = new URL(input.directDestinationUrl);
    const linkedIn = destination.hostname === "linkedin.com" || destination.hostname.endsWith(".linkedin.com");
    return linkedIn || input.directDestinationUrl === input.linkedinUrl || !input.validationSucceeded;
  } catch {
    return true;
  }
}

/**
 * Safely captures a screenshot and returns the filepath only if successfully written.
 */
async function captureSafeScreenshot(page: Page, targetPath: string): Promise<string | null> {
  try {
    await page.screenshot({ path: targetPath, timeout: 5000 });
    const stat = await fs.stat(targetPath);
    if (stat.size > 0) {
      return targetPath;
    }
  } catch {
    // Return null if screenshot could not be captured
  }
  return null;
}

/**
 * Resolves a job URL from a LinkedIn job posting using direct apply or company-site fallback.
 */
export async function resolveDirectLinkedInJob(rawInput: ResolverInput): Promise<ResolverResult> {
  const startTime = Date.now();
  const trace: string[] = [];
  const screenshots: string[] = [];

  // 1. Strict deterministic input validation before creating browser session
  const parseResult = ResolverInputSchema.safeParse(rawInput);
  if (!parseResult.success) {
    const errorMsg = parseResult.error.errors.map((e) => e.message).join("; ");
    return {
      success: false,
      linkedinUrl: rawInput?.linkedinUrl || "",
      error: errorMsg,
      runtimeMs: Date.now() - startTime,
      trace: ["Input validation failed: invalid LinkedIn job listing URL"],
    };
  }

  const { linkedinUrl } = parseResult.data;

  const bbApiKey = process.env.BROWSERBASE_API_KEY;
  const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
  const bbContextId = process.env.BROWSERBASE_CONTEXT_ID;
  const useLocalBrowser = process.env.BROWSER_PROVIDER === "local";

  if (!useLocalBrowser && (!bbApiKey || !bbProjectId)) {
    return {
      success: false,
      linkedinUrl,
      error: "Missing BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID in environment",
      runtimeMs: Date.now() - startTime,
      trace: ["Environment check failed: missing Browserbase credentials"],
    };
  }

  let modelConfig;
  try {
    modelConfig = getStagehandModelConfig();
  } catch (error) {
    return {
      success: false,
      linkedinUrl,
      error: safeError(error),
      runtimeMs: Date.now() - startTime,
      trace: ["Environment check failed: invalid LLM configuration"],
    };
  }

  const screenshotsDir = path.resolve(process.cwd(), "screenshots");
  await fs.mkdir(screenshotsDir, { recursive: true });

  let stagehand: Stagehand | undefined;

  try {
    const localCookies = useLocalBrowser ? await loadLocalBrowserCookies() : undefined;
    trace.push(`Connecting to ${useLocalBrowser ? "local Chrome" : "Browserbase remote browser"} with Stagehand and ${modelConfig.label}`);

    stagehand = new Stagehand({
      env: useLocalBrowser ? "LOCAL" : "BROWSERBASE",
      apiKey: useLocalBrowser ? undefined : bbApiKey,
      projectId: useLocalBrowser ? undefined : bbProjectId,
      ...modelConfig.options,
      logger: () => {},
      localBrowserLaunchOptions: useLocalBrowser
        ? {
            executablePath: LOCAL_CHROME_PATH,
            headless: false,
            viewport: { width: 1440, height: 1000 },
            cookies: localCookies,
          }
        : undefined,
      browserbaseSessionCreateParams: useLocalBrowser ? undefined : {
        browserSettings: bbContextId
          ? {
              context: {
                id: bbContextId,
                persist: true,
              },
            }
          : undefined,
      },
    });

    await stagehand.init();
    const page = stagehand.page;

    trace.push("Opened LinkedIn listing");
    await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator("body").waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
    await page.locator("h1").first().waitFor({ state: "attached", timeout: 8000 }).catch(() => {});

    // Save LinkedIn page screenshot
    const linkedinScreenshotPath = path.join(screenshotsDir, `linkedin_${Date.now()}.png`);
    const savedLinkedinScreenshot = await captureSafeScreenshot(page, linkedinScreenshotPath);
    if (savedLinkedinScreenshot) {
      screenshots.push(savedLinkedinScreenshot);
    }

    // Check for initial auth wall
    const isBlocked = await checkLinkedInAuthWall(page);
    if (isBlocked) {
      trace.push("LinkedIn presented an authentication barrier");
      return {
        success: false,
        linkedinUrl,
        error: "LinkedIn authentication or verification barrier encountered (sign-in required)",
        runtimeMs: Date.now() - startTime,
        trace,
        screenshots,
      };
    }

    const listingSignals = await readLinkedInListingSignals(page);
    let identity: z.infer<typeof LinkedInIdentitySchema> = listingSignals;
    if (!identity.company || !identity.jobTitle) {
      trace.push(`Structured listing data was incomplete; extracting identity via Stagehand with ${modelConfig.label}`);
      try {
        identity = await stagehand.extract({
          instruction: "Extract the exact hiring company name, job title, and visible location from this LinkedIn job listing.",
          schema: LinkedInIdentitySchema,
        });
      } catch (err: unknown) {
        trace.push(`Stagehand identity extraction error: ${safeError(err, [bbApiKey || "", bbContextId || "", modelConfig.secret])}`);
        return {
          success: false,
          linkedinUrl,
          error: "Could not identify required company name or job title on listing using Stagehand",
          runtimeMs: Date.now() - startTime,
          trace,
          screenshots,
        };
      }
    }

    const company = identity?.company?.trim();
    const jobTitle = identity?.jobTitle?.trim();
    const location = identity?.location?.trim();

    if (!company || !jobTitle) {
      const missingField = !company && !jobTitle ? "company name and job title" : !company ? "company name" : "job title";
      trace.push(`Failed to extract ${missingField} from LinkedIn listing`);
      return {
        success: false,
        company: company || undefined,
        jobTitle: jobTitle || undefined,
        linkedinUrl,
        error: `Could not identify required ${missingField} on listing`,
        runtimeMs: Date.now() - startTime,
        trace,
        screenshots,
      };
    }

    trace.push(`Identified company: "${company}" and job: "${jobTitle}"`);

    // Stagehand Operation 2: Try Direct Apply Discovery and Activation
    trace.push("Discovering direct external Apply control via Stagehand");
    let destinationPage: Page = page;
    let externalJobUrl = "";
    let directDestinationAuthGate = false;

    try {
      const popupCapture: { page: Page | null } = { page: null };
      if (listingSignals.externalApplyUrl) {
        trace.push("Found direct external Apply URL in LinkedIn page data");
        await page.goto(listingSignals.externalApplyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } else if (!listingSignals.easyApplyVisible) {
        const context = page.context();
        const recordPopup = (newPage: Page) => {
          popupCapture.page ??= newPage;
        };
        context.on("page", recordPopup);
        try {
          await stagehand.act({
            action: "Click the direct external apply button (such as 'Apply on company website' or external 'Apply'). Do NOT click 'Easy Apply'.",
          });
        } finally {
          context.off("page", recordPopup);
        }
      } else {
        trace.push("LinkedIn exposes Easy Apply but no direct external Apply URL");
      }

      const popup = popupCapture.page;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        const popupUrl = popup.url();
        if (popupUrl) {
          await page.goto(popupUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        }
        await popup.close().catch(() => {});
        destinationPage = page;
      }

      await destinationPage.locator("body").waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
      externalJobUrl = destinationPage.url();

      const isDestAuthGate = await checkLinkedInAuthWall(destinationPage);
      directDestinationAuthGate = isDestAuthGate;
      if (
        !isDestAuthGate &&
        externalJobUrl &&
        externalJobUrl !== linkedinUrl &&
        !externalJobUrl.includes("linkedin.com")
      ) {
        // Validate direct destination
        trace.push(`Followed direct external destination: ${externalJobUrl}`);

        trace.push(`Validating direct destination identity via Stagehand with ${modelConfig.label}`);
        const semanticEvaluation = await stagehand.extract({
          instruction: `Determine whether this destination page is for company "${company}" and the exact role "${jobTitle}". Set pageType to "job" only if this is a dedicated single-job posting. Return direct quotes from the visible page as companyEvidence and jobEvidence.`,
          schema: DestinationIdentitySchema,
        });

        const validation = validateDestination({
          company,
          jobTitle,
          destinationUrl: externalJobUrl,
          semanticEvaluation,
        });

        if (validation.isValid) {
          const destScreenshotPath = path.join(screenshotsDir, `destination_${Date.now()}.png`);
          const savedDestScreenshot = await captureSafeScreenshot(destinationPage, destScreenshotPath);
          if (savedDestScreenshot) screenshots.push(savedDestScreenshot);
          trace.push(
            `Validated direct destination matches company and job (Evidence: ${validation.evidence?.companyEvidence || "verified"} | ${validation.evidence?.jobEvidence || "verified"})`
          );

          return {
            success: true,
            company,
            jobTitle,
            linkedinUrl,
            externalJobUrl,
            runtimeMs: Date.now() - startTime,
            trace,
            screenshots,
          };
        }
      }
    } catch (err: unknown) {
      trace.push(`Direct Apply attempt note: ${safeError(err, [bbApiKey || "", bbContextId || "", modelConfig.secret])}`);
    }

    if (!shouldEnterCompanySiteFallback({
      directDestinationUrl: externalJobUrl,
      linkedinUrl,
      isAuthGate: directDestinationAuthGate,
      validationSucceeded: false,
    })) {
      throw new Error("Direct destination was neither accepted nor eligible for fallback");
    }

    trace.push("Direct external apply unavailable or unvalidated; entering company-site fallback");
    if (page.url() !== linkedinUrl) {
      await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.locator("body").waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
    }
    if (await checkLinkedInAuthWall(page)) {
      return {
        success: false,
        company,
        jobTitle,
        linkedinUrl,
        error: "LinkedIn authentication or verification barrier encountered before company-site fallback",
        runtimeMs: Date.now() - startTime,
        trace: [...trace, "LinkedIn presented an authentication barrier before fallback"],
        screenshots,
      };
    }

    return await resolveCompanySiteFallback({
      stagehand,
      company,
      jobTitle,
      location,
      companyProfileUrl: listingSignals.companyProfileUrl,
      linkedinUrl,
      trace,
      screenshots,
      screenshotsDir,
      startTime,
      secrets: [bbApiKey || "", bbContextId || "", modelConfig.secret],
    });
  } catch (err: unknown) {
    const sanitizedError = safeError(err, [bbApiKey || "", bbContextId || "", modelConfig?.secret || ""]);

    trace.push(`Execution error: ${sanitizedError}`);

    return {
      success: false,
      linkedinUrl,
      error: sanitizedError,
      runtimeMs: Date.now() - startTime,
      trace,
      screenshots,
    };
  } finally {
    if (stagehand) {
      if (useLocalBrowser) {
        await saveLocalBrowserState(stagehand.context).catch(() => {});
      }
      await stagehand.close().catch(() => {});
    }
  }
}
