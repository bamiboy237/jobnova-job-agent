import { GoogleGenAI } from "@google/genai";
import { type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  LLMClient,
  type CreateChatCompletionOptions,
  type LLMResponse,
} from "@browserbasehq/stagehand";

export class GeminiStagehandClient extends LLMClient {
  public ai: GoogleGenAI;
  public model: string;

  constructor(apiKey: string, model: string = "gemini-3.7-flash") {
    // @ts-ignore
    super("gpt-4o"); // pass base modelName to satisfies Stagehand enum
    this.type = "gemini";
    this.model = model;
    this.modelName = "gpt-4o" as any;
    this.hasVision = true;
    this.ai = new GoogleGenAI({ apiKey });
  }

  async createChatCompletion<T = LLMResponse>({
    options,
    logger,
  }: CreateChatCompletionOptions): Promise<T> {
    const contents: any[] = [];

    for (const msg of options.messages) {
      if (typeof msg.content === "string") {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        const parts: any[] = [];
        for (const part of msg.content) {
          if (part.type === "text" && "text" in part) {
            parts.push({ text: part.text });
          } else if (part.type === "image_url" && "image_url" in part) {
            const base64Data = part.image_url.url.split(",")[1] || part.image_url.url;
            parts.push({
              inlineData: {
                mimeType: "image/png",
                data: base64Data,
              },
            });
          }
        }
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts,
        });
      }
    }

    if (options.image?.buffer) {
      contents.push({
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/png",
              data: options.image.buffer.toString("base64"),
            },
          },
          { text: options.image.description || "Annotated screenshot" },
        ],
      });
    }

    const config: any = {};

    if (options.response_model) {
      config.responseMimeType = "application/json";
      config.responseSchema = zodToJsonSchema(options.response_model.schema as any);
    }

    if (options.tools && options.tools.length > 0) {
      // Map tools to Gemini function declarations
      const functionDeclarations = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      config.tools = [{ functionDeclarations }];
    }

    let response: any;
    let lastError: any;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await this.ai.models.generateContent({
          model: this.model,
          contents,
          config,
        });
        break;
      } catch (err: any) {
        lastError = err;
        const isTransient =
          err?.status === "UNAVAILABLE" ||
          err?.message?.includes("503") ||
          err?.message?.includes("429") ||
          err?.message?.includes("high demand") ||
          err?.message?.includes("Resource exhausted");

        if (isTransient && attempt < maxRetries) {
          const delayMs = attempt * 2000;
          logger?.({
            category: "gemini",
            message: `Transient error (attempt ${attempt}/${maxRetries}), retrying in ${delayMs}ms...`,
            level: 1,
          });
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          throw err;
        }
      }
    }

    const responseText = response?.text || "";

    // Handle tool calls
    const candidates = response.candidates || [];
    const firstCandidate = candidates[0];
    const functionCalls = firstCandidate?.content?.parts?.filter((p: any) => p.functionCall);

    if (functionCalls && functionCalls.length > 0) {
      const toolCalls = functionCalls.map((fc: any, i: number) => ({
        id: `call_${i}`,
        type: "function" as const,
        function: {
          name: fc.functionCall.name,
          arguments: JSON.stringify(fc.functionCall.args || {}),
        },
      }));

      return {
        id: `gemini-${Date.now()}`,
        object: "chat.completion",
        created: Date.now(),
        model: this.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: responseText,
              tool_calls: toolCalls,
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      } as T;
    }

    if (options.response_model) {
      try {
        const parsed = JSON.parse(responseText);
        return parsed as T;
      } catch {
        // Fall back to returning standard response
      }
    }

    return {
      id: `gemini-${Date.now()}`,
      object: "chat.completion",
      created: Date.now(),
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: responseText,
            tool_calls: [],
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    } as T;
  }
}
