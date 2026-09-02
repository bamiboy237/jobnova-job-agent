import type { ModelConfiguration } from "@mastra/stagehand";

export interface ResolverModelConfig {
  agentModel: {
    id: `${string}/${string}`;
    apiKey: string;
  };
  browserModel: ModelConfiguration;
  agentProviderOptions?: {
    openai?: { reasoningEffort: "medium" };
    google?: { thinkingConfig: { thinkingLevel: "medium" } };
  };
  label: string;
  secrets: string[];
}

export function getResolverModelConfig(): ResolverModelConfig {
  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();

  if (provider === "openai") {
    const apiKey = requireApiKey("OPENAI_API_KEY");
    return {
      agentModel: { id: "openai/gpt-5.6-luna", apiKey },
      browserModel: {
        modelName: "openai/gpt-5.6-luna",
        apiKey,
        reasoningEffort: "medium",
      },
      agentProviderOptions: { openai: { reasoningEffort: "medium" } },
      label: "OpenAI GPT-5.6 Luna (medium reasoning)",
      secrets: [apiKey],
    };
  }

  if (provider === "gemini") {
    const apiKey = requireApiKey("GEMINI_API_KEY");
    return {
      agentModel: { id: "google/gemini-3.7-flash", apiKey },
      browserModel: {
        modelName: "google/gemini-3.7-flash",
        apiKey,
      },
      agentProviderOptions: { google: { thinkingConfig: { thinkingLevel: "medium" } } },
      label: "Gemini 3.7 Flash (dynamic thinking)",
      secrets: [apiKey],
    };
  }

  if (provider === "deepseek") {
    const apiKey = requireApiKey("DEEPSEEK_API_KEY");
    return {
      agentModel: { id: "deepseek/deepseek-v4-flash-vision-exp", apiKey },
      browserModel: "deepseek/deepseek-v4-flash-vision-exp",
      label: "DeepSeek V4 Flash Vision (experimental)",
      secrets: [apiKey],
    };
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

function requireApiKey(name: "OPENAI_API_KEY" | "GEMINI_API_KEY" | "DEEPSEEK_API_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in environment`);
  return value;
}
