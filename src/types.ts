import { z } from "zod";

/**
 * Validates that the input is a valid HTTPS LinkedIn job listing URL.
 * Accepts formats like https://www.linkedin.com/jobs/view/<job_id>
 */
export function isValidLinkedInJobUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const isExactHost = parsed.hostname === "linkedin.com" || parsed.hostname === "www.linkedin.com";
    const isExactJobPath = /^\/jobs\/view\/[0-9]+\/?$/i.test(parsed.pathname);

    return isHttps && isExactHost && isExactJobPath;
  } catch {
    return false;
  }
}

export const ResolverInputSchema = z.object({
  linkedinUrl: z
    .string()
    .url("A valid URL is required")
    .refine(isValidLinkedInJobUrl, {
      message: "Input must be an HTTPS LinkedIn job URL (e.g. https://www.linkedin.com/jobs/view/<job_id>)",
    }),
});

export type ResolverInput = z.infer<typeof ResolverInputSchema>;

export const ResolverSuccessResultSchema = z.object({
  success: z.literal(true),
  company: z.string().min(1, "Company name cannot be empty"),
  jobTitle: z.string().min(1, "Job title cannot be empty"),
  linkedinUrl: z.string(),
  externalJobUrl: z.string().url(),
  runtimeMs: z.number(),
  trace: z.array(z.string()),
  screenshots: z.array(z.string()).optional(),
});

export type ResolverSuccessResult = z.infer<typeof ResolverSuccessResultSchema>;

export const ResolverFailureResultSchema = z.object({
  success: z.literal(false),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  linkedinUrl: z.string(),
  externalJobUrl: z.string().optional(),
  error: z.string(),
  runtimeMs: z.number(),
  trace: z.array(z.string()),
  screenshots: z.array(z.string()).optional(),
});

export type ResolverFailureResult = z.infer<typeof ResolverFailureResultSchema>;

export type ResolverResult = ResolverSuccessResult | ResolverFailureResult;
