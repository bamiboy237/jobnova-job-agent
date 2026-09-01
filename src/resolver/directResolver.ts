import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentBrowser } from "@mastra/agent-browser";
import {
  ResolverInputSchema,
  type ResolverInput,
  type ResolverMetrics,
  type ResolverResult,
} from "../types.js";
import { getResolverModelConfig } from "../mastra/model.js";
import { createResolverRuntime, ResolverAgentOutputSchema } from "../mastra/resolverAgent.js";
import { compactSupersededSnapshots } from "../mastra/compactSnapshots.js";
import { collectEnvSecrets, safeError } from "./browserSafety.js";
import { validateDestination } from "./validateDestination.js";

const MAX_AGENT_STEPS = 16;
const PLACEHOLDER_IDENTITY = /^(unknown|n\/?a|none|not found|not available|tbd)$/i;

export async function resolveDirectLinkedInJob(rawInput: ResolverInput): Promise<ResolverResult> {
  const startedAt = Date.now();
  const parsedInput = ResolverInputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return {
      success: false,
      linkedinUrl: rawInput?.linkedinUrl || "",
      error: parsedInput.error.errors.map((error) => error.message).join("; "),
      runtimeMs: Date.now() - startedAt,
      trace: ["Input validation failed"],
    };
  }

  const { linkedinUrl } = parsedInput.data;
  let modelConfig: ReturnType<typeof getResolverModelConfig>;
  try {
    modelConfig = getResolverModelConfig();
  } catch (error) {
    return failure(linkedinUrl, startedAt, safeError(error, collectEnvSecrets()), ["Environment check failed"]);
  }

  const trace: string[] = [`Started Mastra resolver agent with ${modelConfig.label}`];
  const candidates: string[] = [];
  const observedCandidates: Array<{ url: string; observedAt: number }> = [];
  const screenshots: string[] = [];
  const repeatedMutations = new Map<string, number>();
  const toolStarts = new Map<string, number[]>();
  let deterministicToolDurationMs = 0;
  let stagehandModelCalls = 0;
  let linkedInAuthBlocked = false;
  const runId = randomUUID();
  const { mastra, browsers } = createResolverRuntime(modelConfig);
  let browserSetupMs = 0;
  let agentStartedAt = 0;
  let agentFinishedAt = 0;
  let outerModelCalls = 0;

  try {
    const browserSetupStartedAt = Date.now();
    await browsers.actionBrowser.ensureReady();
    browserSetupMs = Date.now() - browserSetupStartedAt;

    const agent = mastra.getAgentById("linkedin-resolver");
    agentStartedAt = Date.now();
    const navigationOutput = await agent.generate(
      `Navigate from this LinkedIn listing to the matching job-specific external page: ${linkedinUrl}. Stop after a fresh snapshot confirms the best candidate; do not keep exploring after the exact job is visible.`,
      {
        runId,
        memory: {
          resource: linkedinUrl,
          thread: runId,
        },
        maxSteps: MAX_AGENT_STEPS,
        providerOptions: modelConfig.agentProviderOptions,
        prepareStep: ({ messages }) => ({ messages: compactSupersededSnapshots(messages) }),
        hooks: {
          beforeToolCall: ({ toolName, input }) => {
            const starts = toolStarts.get(toolName) || [];
            starts.push(Date.now());
            toolStarts.set(toolName, starts);
            if (toolName.startsWith("stagehand_")) stagehandModelCalls += 1;

            if (toolName !== "browser_click" && toolName !== "browser_goto") return;
            const key = `${toolName}:${JSON.stringify(input)}`;
            const count = (repeatedMutations.get(key) || 0) + 1;
            repeatedMutations.set(key, count);
            if (count >= 3) {
              return {
                proceed: false as const,
                output: { success: false, error: "Repeated browser mutation blocked; inspect current state and choose a different action." },
              };
            }
          },
          afterToolCall: async ({ toolName, output: toolOutput, error }) => {
            const started = toolStarts.get(toolName)?.pop();
            if (started !== undefined && !toolName.startsWith("stagehand_")) {
              deterministicToolDurationMs += Date.now() - started;
            }
            if (error) {
              trace.push(`${toolName} failed`);
              return;
            }
            const url = readOutputUrl(toolOutput);
            if (toolName.startsWith("browser_")) {
              for (const observedUrl of readObservedUrls(toolOutput)) {
                if (isLinkedInAuthUrl(observedUrl)) linkedInAuthBlocked = true;
                if (isExternalHttpsUrl(observedUrl)) {
                  candidates.push(observedUrl);
                  observedCandidates.push({ url: observedUrl, observedAt: Date.now() });
                }
              }
            }
            if (toolName === "browser_goto" && url?.includes("linkedin.com/jobs/view/") && screenshots.length === 0) {
              const screenshot = await captureScreenshot(browsers.actionBrowser, runId, "linkedin");
              if (screenshot) screenshots.push(screenshot);
            }
            trace.push(toolTrace(toolName, url));
          },
        },
      },
    );
    outerModelCalls = navigationOutput.steps.length;

    const output = await agent.generate(
      "Return the final resolver evidence from this thread. Use only the LinkedIn identity and destination page evidence already observed. Do not invent or propose a URL that the browser did not visit.",
      {
        runId: `${runId}-final`,
        memory: {
          resource: linkedinUrl,
          thread: runId,
        },
        maxSteps: 1,
        toolChoice: "none",
        providerOptions: modelConfig.agentProviderOptions,
        structuredOutput: {
          schema: ResolverAgentOutputSchema,
          jsonPromptInjection: "auto",
          errorStrategy: "strict",
        },
        prepareStep: ({ messages }) => ({ messages: compactSupersededSnapshots(messages) }),
      },
    );
    agentFinishedAt = Date.now();
    outerModelCalls += output.steps.length;

    const evidence = ResolverAgentOutputSchema.parse(output.object);
    const company = cleanIdentity(evidence.company);
    const jobTitle = cleanIdentity(evidence.jobTitle);
    const destinationScreenshot = await captureScreenshot(browsers.actionBrowser, runId, "destination");
    if (destinationScreenshot) screenshots.push(destinationScreenshot);
    const candidateUrl = bestCandidate(evidence.candidateUrl, candidates);
    const metrics = buildResolverMetrics({
      browserSetupMs,
      agentStartedAt,
      agentFinishedAt,
      completedAt: Date.now(),
      deterministicToolDurationMs,
      modelCalls: outerModelCalls + stagehandModelCalls,
      observedCandidates,
      finalCandidateUrl: candidateUrl,
    });

    if (!company || !jobTitle) {
      return failure(
        linkedinUrl,
        startedAt,
        evidence.blocker || "LinkedIn listing did not expose a valid company and job title",
        trace,
        { company, jobTitle, externalJobUrl: candidateUrl, screenshots, metrics },
      );
    }

    if (!candidateUrl) {
      return failure(
        linkedinUrl,
        startedAt,
        evidence.blocker || "No job-specific external destination could be verified",
        trace,
        { company, jobTitle, screenshots, metrics },
      );
    }

    const validation = validateDestination({
      company,
      jobTitle,
      destinationUrl: candidateUrl,
      semanticEvaluation: {
        pageType: evidence.pageType,
        companyMatches: evidence.companyMatches,
        jobMatches: evidence.jobMatches,
        companyEvidence: evidence.companyEvidence,
        jobEvidence: evidence.jobEvidence,
      },
    });

    if (!validation.isValid) {
      return failure(
        linkedinUrl,
        startedAt,
        evidence.blocker || validation.reason || "Destination validation was uncertain",
        [...trace, "Preserved the strongest candidate after validation did not pass"],
        { company, jobTitle, externalJobUrl: candidateUrl, screenshots, metrics },
      );
    }

    return {
      success: true,
      company,
      jobTitle,
      linkedinUrl,
      externalJobUrl: candidateUrl,
      runtimeMs: Date.now() - startedAt,
      trace: [...trace, "Validated destination against visible company and job evidence"],
      screenshots,
      metrics,
    };
  } catch (error) {
    if (!agentFinishedAt && agentStartedAt) agentFinishedAt = Date.now();
    const failureScreenshot = await captureScreenshot(browsers.actionBrowser, runId, "failure");
    if (failureScreenshot) screenshots.push(failureScreenshot);
    const finalCandidateUrl = candidates.at(-1);
    const metrics = buildResolverMetrics({
      browserSetupMs,
      agentStartedAt,
      agentFinishedAt,
      completedAt: Date.now(),
      deterministicToolDurationMs,
      modelCalls: outerModelCalls + stagehandModelCalls,
      observedCandidates,
      finalCandidateUrl,
    });
    return failure(
      linkedinUrl,
      startedAt,
      linkedInAuthBlocked
        ? "LinkedIn authentication is required in the active browser profile"
        : safeError(error, [...collectEnvSecrets(), ...modelConfig.secrets]),
      [...trace, "Mastra resolver agent stopped"],
      { externalJobUrl: finalCandidateUrl, screenshots, metrics },
    );
  } finally {
    await browsers.close();
  }
}

export function buildResolverMetrics(input: {
  browserSetupMs: number;
  agentStartedAt: number;
  agentFinishedAt: number;
  completedAt: number;
  deterministicToolDurationMs: number;
  modelCalls: number;
  observedCandidates: Array<{ url: string; observedAt: number }>;
  finalCandidateUrl?: string;
}): ResolverMetrics {
  const agentDurationMs = input.agentStartedAt && input.agentFinishedAt
    ? Math.max(0, input.agentFinishedAt - input.agentStartedAt)
    : 0;
  const firstExternalAt = input.observedCandidates[0]?.observedAt;
  const normalizedFinal = input.finalCandidateUrl ? normalizeUrl(input.finalCandidateUrl) : undefined;
  const finalCandidateAt = normalizedFinal
    ? input.observedCandidates.find((candidate) => normalizeUrl(candidate.url) === normalizedFinal)?.observedAt
    : undefined;
  const linkedinInspectionEnd = firstExternalAt || input.agentFinishedAt || input.completedAt;
  const linkedinInspectionMs = input.agentStartedAt
    ? Math.max(0, linkedinInspectionEnd - input.agentStartedAt)
    : 0;
  const companyCareersNavigationMs = firstExternalAt && finalCandidateAt
    ? Math.max(0, finalCandidateAt - firstExternalAt)
    : 0;
  const finalValidationStartedAt = finalCandidateAt || input.agentFinishedAt || input.completedAt;

  return {
    modelCalls: input.modelCalls,
    modelDurationMs: Math.max(0, agentDurationMs - input.deterministicToolDurationMs),
    phases: {
      browserSetupMs: input.browserSetupMs,
      linkedinInspectionMs,
      companyCareersNavigationMs,
      finalValidationMs: Math.max(0, input.completedAt - finalValidationStartedAt),
    },
  };
}

export function cleanIdentity(value: string): string | undefined {
  const cleaned = value.trim();
  return cleaned && !PLACEHOLDER_IDENTITY.test(cleaned) ? cleaned : undefined;
}

export function bestCandidate(modelCandidate: string, observedCandidates: string[]): string | undefined {
  const observed = observedCandidates.filter(isExternalHttpsUrl);
  const cleaned = normalizeUrl(modelCandidate);
  if (!cleaned) return undefined;
  return [...observed].reverse().find((candidate) => normalizeUrl(candidate) === cleaned);
}

function isExternalHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "linkedin.com" && !url.hostname.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

export function isLinkedInAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hostname !== "linkedin.com" && !url.hostname.endsWith(".linkedin.com")) return false;
    return [
      "/authwall",
      "/login",
      "/signup",
      "/checkpoint",
      "/cold-join",
      "/challenge",
      "/verification",
    ].some((path) => url.pathname.toLowerCase().includes(path));
  } catch {
    return false;
  }
}

function readOutputUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("url" in value)) return undefined;
  return typeof value.url === "string" ? value.url : undefined;
}

export function readObservedUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(readObservedUrls);

  const urls: string[] = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "url" && typeof nestedValue === "string") urls.push(nestedValue);
    if (key === "tabs" && Array.isArray(nestedValue)) urls.push(...readObservedUrls(nestedValue));
  }
  return urls;
}

function normalizeUrl(value: string): string | undefined {
  try {
    return new URL(value.trim()).href;
  } catch {
    return undefined;
  }
}

function toolTrace(toolName: string, url?: string): string {
  if (toolName === "browser_goto") return url ? `Navigated to ${new URL(url).hostname}` : "Navigated browser";
  if (toolName === "browser_snapshot") return "Inspected accessibility snapshot";
  if (toolName === "browser_click") return "Performed one deterministic click";
  if (toolName === "browser_tabs") return "Inspected browser tabs";
  if (toolName === "stagehand_observe") return "Observed available page actions";
  if (toolName === "stagehand_extract") return "Extracted unresolved page evidence";
  return `Used ${toolName}`;
}

async function captureScreenshot(browser: AgentBrowser, runId: string, label: string): Promise<string | undefined> {
  try {
    const screenshot = await browser.screenshot({ fullPage: false });
    if (!("base64" in screenshot) || typeof screenshot.base64 !== "string") return undefined;
    const directory = path.resolve(process.cwd(), "screenshots");
    const target = path.join(directory, `resolver_${runId}_${label}.png`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(target, Buffer.from(screenshot.base64, "base64"));
    return target;
  } catch {
    return undefined;
  }
}

function failure(
  linkedinUrl: string,
  startedAt: number,
  error: string,
  trace: string[],
  details: {
    company?: string;
    jobTitle?: string;
    externalJobUrl?: string;
    screenshots?: string[];
    metrics?: ResolverMetrics;
  } = {},
): ResolverResult {
  return {
    success: false,
    linkedinUrl,
    error,
    runtimeMs: Date.now() - startedAt,
    trace,
    ...details,
  };
}
