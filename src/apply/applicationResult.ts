import { z } from "zod";

/** General application controller result; independent of any ATS validation policy. */
export const ApplicationResultSchema = z.object({
  status: z.enum(["ready_to_submit", "submitted", "blocked"]), jobUrl: z.string(), fieldsCompleted: z.array(z.string()), missingRequired: z.array(z.string()), runtimeMs: z.number(), trace: z.array(z.string()), screenshotPath: z.string().optional(), screenshots: z.array(z.string()).optional(), applicationId: z.string().optional(), error: z.string().optional(),
});
export type ApplicationResult = z.infer<typeof ApplicationResultSchema>;
