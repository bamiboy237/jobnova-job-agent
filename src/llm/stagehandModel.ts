import { GeminiStagehandClient } from "./geminiClient.js";
import { OpenAIStagehandClient } from "./openAIClient.js";

export function getStagehandModelConfig() {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY in environment");

    return {
      label: "OpenAI GPT-5.6 Luna (high reasoning)",
      secret: apiKey,
      options: {
        llmClient: new OpenAIStagehandClient(apiKey),
      },
    };
  }

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY in environment");

    return {
      label: "Gemini 3.7 Flash",
      secret: apiKey,
      options: {
        llmClient: new GeminiStagehandClient(apiKey, "gemini-3.7-flash"),
      },
    };
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}
