import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  LLMClient,
  type CreateChatCompletionOptions,
  type LLMResponse,
} from "@browserbasehq/stagehand";

export class OpenAIStagehandClient extends LLMClient {
  private client: OpenAI;

  constructor(apiKey: string) {
    super("gpt-5.6-luna" as any);
    this.type = "openai";
    this.modelName = "gpt-5.6-luna" as any;
    this.hasVision = true;
    this.client = new OpenAI({ apiKey, timeout: 60000, maxRetries: 1 });
  }

  async createChatCompletion<T = LLMResponse>({
    options,
  }: CreateChatCompletionOptions): Promise<T> {
    const input: any[] = options.messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) =>
              "image_url" in part
                ? { type: "input_image", image_url: part.image_url.url, detail: "original" }
                : { type: "input_text", text: part.text },
            ),
    }));

    if (options.image?.buffer) {
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: options.image.description || "Annotated screenshot" },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${options.image.buffer.toString("base64")}`,
            detail: "original",
          },
        ],
      });
    }

    const response = await this.client.responses.create({
      model: "gpt-5.6-luna",
      input,
      reasoning: { effort: "high" },
      store: false,
      ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
      ...(options.response_model
        ? {
            text: {
              format: {
                type: "json_schema",
                name: options.response_model.name,
                schema: zodToJsonSchema(options.response_model.schema),
                strict: true,
              },
            },
          }
        : {}),
      ...(options.tools?.length
        ? {
            tools: options.tools.map((tool) => ({
              type: "function" as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false,
            })),
            tool_choice: options.tool_choice || "auto",
          }
        : {}),
    } as any);

    if (options.response_model) {
      return JSON.parse(response.output_text) as T;
    }

    const toolCalls = response.output
      .filter((item: any) => item.type === "function_call")
      .map((item: any) => ({
        id: item.call_id,
        type: "function" as const,
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      }));

    return {
      id: response.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-5.6-luna",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.output_text || null,
            tool_calls: toolCalls,
          },
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
    } as T;
  }
}
