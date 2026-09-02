import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

export type CareerInteraction =
  | { kind: "user_input"; requestId: string; label: string; inputType: string; description?: string; formatHint?: string; options: string[]; key: string }
  | { kind: "answer_approval"; requestId: string; label: string; draft: string; key: string }
  | { kind: "submission"; requestId: string; prompt: string; completedFields: number; screenshotPath: string };

export interface ActivityData {
  toolCallId: string;
  name: string;
  phase: "started" | "completed" | "failed";
  error?: string;
}

export interface JobnovaDataParts {
  [key: string]: unknown;
  activity: ActivityData;
  interaction: CareerInteraction;
  status: { status: string; detail: string };
}

export type JobnovaMessage = UIMessage<unknown, JobnovaDataParts>;

export class JobnovaTransport implements ChatTransport<JobnovaMessage> {
  private sessionId?: string;
  private responseValue?: string;

  constructor(private readonly accessCode: () => string) {}

  setResponse(value: string): void {
    this.responseValue = value;
  }

  async end(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(`/api/chat/${this.sessionId}/end`, {
      method: "POST",
      headers: { "x-access-code": this.accessCode() },
    });
    this.sessionId = undefined;
  }

  sendMessages: ChatTransport<JobnovaMessage>["sendMessages"] = async ({ messages, abortSignal }) => {
    const sessionId = await this.ensureSession();
    const latest = messages.at(-1);
    const text = latest?.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("") ?? "";
    return this.request(`/api/chat/${sessionId}/message`, { text }, abortSignal);
  };

  reconnectToStream: ChatTransport<JobnovaMessage>["reconnectToStream"] = async ({ abortSignal }) => {
    if (!this.sessionId || this.responseValue === undefined) return null;
    const value = this.responseValue;
    this.responseValue = undefined;
    return this.request(`/api/chat/${this.sessionId}/respond`, { value }, abortSignal);
  };

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "x-access-code": this.accessCode() },
    });
    const body = await response.json() as { sessionId?: string; error?: string };
    if (!response.ok || !body.sessionId) throw new Error(body.error || "Could not start the career session.");
    this.sessionId = body.sessionId;
    return body.sessionId;
  }

  private async request(path: string, body: Record<string, string>, abortSignal?: AbortSignal): Promise<ReadableStream<UIMessageChunk>> {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-code": this.accessCode(),
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(error.error || "The career agent could not continue.");
    }
    if (!response.body) throw new Error("The career agent returned an empty stream.");
    return careerEventsToMessageChunks(response.body);
  }
}

function careerEventsToMessageChunks(input: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const messageId = crypto.randomUUID();
  const textId = crypto.randomUUID();
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      controller.enqueue({ type: "start", messageId });
      const reader = input.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let textStarted = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          const records = buffer.split("\n\n");
          buffer = records.pop() || "";
          for (const record of records) {
            const dataLine = record.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            const event = JSON.parse(dataLine.slice(5).trim()) as Record<string, any>;
            if (event.type === "text_delta") {
              if (!textStarted) {
                controller.enqueue({ type: "text-start", id: textId });
                textStarted = true;
              }
              controller.enqueue({ type: "text-delta", id: textId, delta: String(event.delta) });
            } else if (event.type === "tool") {
              controller.enqueue({
                type: "data-activity",
                id: `${event.toolCallId}-${event.phase}`,
                data: {
                  toolCallId: String(event.toolCallId),
                  name: String(event.name),
                  phase: event.phase,
                  ...(event.error ? { error: String(event.error) } : {}),
                },
              });
            } else if (event.type === "interaction") {
              controller.enqueue({
                type: "data-interaction",
                id: String(event.interaction.requestId),
                data: event.interaction,
              });
            } else if (event.type === "status") {
              controller.enqueue({
                type: "data-status",
                id: crypto.randomUUID(),
                data: { status: String(event.status), detail: String(event.detail) },
                transient: true,
              });
            } else if (event.type === "error") {
              controller.enqueue({ type: "error", errorText: String(event.error) });
            }
          }
          if (done) break;
        }
        if (textStarted) controller.enqueue({ type: "text-end", id: textId });
        controller.enqueue({ type: "finish", finishReason: "stop" });
        controller.close();
      } catch (error) {
        controller.enqueue({ type: "error", errorText: error instanceof Error ? error.message : "Chat stream failed." });
        controller.close();
      }
    },
  });
}
