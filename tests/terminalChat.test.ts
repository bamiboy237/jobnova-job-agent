import { describe, expect, it } from "vitest";
import { parseClientCommand, TerminalChat, type TerminalClientDependencies } from "../src/apply/terminalChat.js";
import type { CareerEvent, CareerSession } from "../src/career/careerSession.js";

async function* emit(events: CareerEvent[]): AsyncGenerator<CareerEvent> {
  for (const event of events) yield event;
}

function setup(options: { send?: (message: string) => CareerEvent[]; respond?: (input: string) => CareerEvent[] } = {}) {
  let creates = 0; let closes = 0; let interrupts = 0;
  const messages: string[] = []; const responses: string[] = [];
  const session: CareerSession = {
    threadId: "career-thread",
    sendMessage: (message) => { messages.push(message); return emit(options.send?.(message) ?? [{ type: "text_delta", delta: `Reply: ${message}` }]); },
    respond: (input) => { responses.push(input); return emit(options.respond?.(input) ?? [{ type: "text_delta", delta: "Continuing." }]); },
    status: () => ({ threadId: "career-thread", mode: "conversation", working: false, waitingForInput: false }),
    interrupt: () => { interrupts += 1; },
    close: async () => { closes += 1; },
  };
  const deps: TerminalClientDependencies = { createSession: async () => { creates += 1; return session; } };
  let output = "";
  const client = new TerminalChat({ deps, output: { write: (value: string) => { output += value; return true; } } as never });
  return { client, messages, responses, output: () => output, counts: () => ({ creates, closes, interrupts }) };
}

describe("career-agent terminal interaction layer", () => {
  it("keeps only lifecycle slash commands local", () => {
    expect(parseClientCommand("/status")).toBe("status");
    expect(parseClientCommand("/cancel")).toBe("cancel");
    expect(parseClientCommand("/submit")).toBeUndefined();
    expect(parseClientCommand("hey")).toBeUndefined();
  });

  it("forwards pre-URL conversation and sequential job messages to one session", async () => {
    const fixture = setup({ send: (message) => message.startsWith("Apply") ? [
      { type: "tool", phase: "started", toolCallId: "job-1", name: "open_supplied_job" },
      { type: "tool", phase: "completed", toolCallId: "job-1", name: "open_supplied_job" },
      { type: "text_delta", delta: "I opened that job." },
    ] : [{ type: "text_delta", delta: "Hey. What are you working toward?" }] });
    await fixture.client.handleInput("hey");
    await fixture.client.handleInput("Apply to https://jobs.example.test/one");
    await fixture.client.handleInput("Apply to https://jobs.example.test/two");
    expect(fixture.counts().creates).toBe(1);
    expect(fixture.messages).toEqual(["hey", "Apply to https://jobs.example.test/one", "Apply to https://jobs.example.test/two"]);
    expect(fixture.output()).toContain("Hey. What are you working toward?");
    expect(fixture.output()).toContain("[>] open_supplied_job");
    await fixture.client.close();
  });

  it("renders structured private input and returns the response through session resume", async () => {
    const fixture = setup({ send: () => [{ type: "interaction", interaction: { kind: "user_input", requestId: "tool-1", label: "Graduation date", inputType: "date", options: [], key: "education.graduation_date" } }] });
    await fixture.client.handleInput("Continue my application");
    await fixture.client.handleInput("2027-05-30");
    expect(fixture.responses).toEqual(["2027-05-30"]);
    expect(fixture.output()).toContain("Graduation date (date)");
    expect(fixture.output()).not.toContain("2027-05-30");
    await fixture.client.close();
  });

  it("ends the session and closes once on cancel", async () => {
    const fixture = setup();
    await fixture.client.handleInput("hey");
    await fixture.client.handleInput("/cancel");
    await fixture.client.handleInput("still there?");
    await fixture.client.close();
    await fixture.client.close();
    expect(fixture.messages).toEqual(["hey"]);
    expect(fixture.counts()).toEqual({ creates: 1, interrupts: 1, closes: 1 });
  });
});
