import * as readline from "node:readline";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import { createCareerSession, resumeCareerSession, type CareerEvent, type CareerInteraction, type CareerSession } from "../career/careerSession.js";

type ClientCommand = "help" | "status" | "cancel" | "resume" | "exit";

export function parseClientCommand(input: string): ClientCommand | undefined {
  const command = input.trim().toLowerCase();
  if (["/help", "/status", "/cancel", "/resume", "/exit"].includes(command)) return command.slice(1) as ClientCommand;
  return undefined;
}

export interface TerminalClientDependencies {
  createSession: typeof createCareerSession;
  resumeSession: typeof resumeCareerSession;
}

export interface TerminalChatOptions {
  input?: Readable;
  output?: Writable;
  deps?: TerminalClientDependencies;
  onExit?: () => void;
}

export class TerminalChat {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly deps: TerminalClientDependencies;
  private readonly onExit?: () => void;
  private rl?: readline.Interface;
  private session?: CareerSession;
  private interaction?: CareerInteraction;
  private privateInputValues: string[] = [];
  private busy = false;
  private closed = false;
  private textOpen = false;
  private finish?: () => void;

  constructor(options: TerminalChatOptions = {}) {
    this.input = options.input ?? defaultStdin;
    this.output = options.output ?? defaultStdout;
    this.deps = options.deps ?? { createSession: createCareerSession, resumeSession: resumeCareerSession };
    this.onExit = options.onExit;
  }

  public async start(initialInput?: string, resume = false): Promise<void> {
    const done = new Promise<void>((resolve) => { this.finish = resolve; });
    this.write("\nJobnova career agent\n");
    this.write("Talk normally. I can discuss, resolve, and apply to jobs with guarded tools.\n");
    this.write("Commands: /help /status /cancel /resume /exit\n\n");
    this.rl = readline.createInterface({ input: this.input, output: this.output, prompt: "> " });
    this.rl.on("line", (line) => { void this.dispatch(line); });
    this.rl.on("close", () => { void this.close(); });
    if (resume) await this.resume();
    this.prompt();
    if (initialInput) void this.dispatch(initialInput);
    await done;
  }

  public async handleInput(rawInput: string): Promise<void> {
    if (this.closed) return;
    const command = parseClientCommand(rawInput);
    if (command === "help") { this.showHelp(); return; }
    if (command === "status") { await this.showStatus(); return; }
    if (command === "cancel") { await this.cancel(); return; }
    if (command === "resume") { await this.resume(); return; }
    if (command === "exit") { await this.close(); return; }
    if (this.busy) { this.write("Agent is working. Use /status, /cancel, or /exit.\n"); return; }
    const message = rawInput.trim();
    if (!message && !this.interaction) return;
    const session = await this.ensureSession();
    if (this.interaction?.kind === "user_inputs") {
      this.privateInputValues.push(rawInput);
      if (this.privateInputValues.length < this.interaction.fields.length) {
        this.renderInputField(this.interaction.fields[this.privateInputValues.length]!, this.privateInputValues.length, this.interaction.fields.length);
        return;
      }
      const values = this.privateInputValues;
      this.privateInputValues = [];
      this.interaction = undefined;
      await this.consume(session.respond(values));
    } else if (this.interaction) {
      this.interaction = undefined;
      await this.consume(session.respond(rawInput));
    } else await this.consume(session.sendMessage(message));
  }

  private async ensureSession(): Promise<CareerSession> {
    if (!this.session) this.session = await this.deps.createSession();
    return this.session;
  }

  private async dispatch(input: string): Promise<void> {
    try { await this.handleInput(input); }
    catch (error) { this.write(`Career session failed: ${error instanceof Error ? error.message : String(error)}\n`); }
    finally { this.prompt(); }
  }

  private async consume(events: AsyncIterable<CareerEvent>): Promise<void> {
    this.busy = true;
    try {
      for await (const event of events) this.renderEvent(event);
    } finally {
      this.endText();
      this.busy = false;
    }
  }

  private renderEvent(event: CareerEvent): void {
    if (event.type === "session_started") this.write(`Thread ${event.threadId}\n`);
    else if (event.type === "status") { this.endText(); this.write(`${event.detail}...\n`); }
    else if (event.type === "text_delta") { this.output.write(event.delta); this.textOpen = true; }
    else if (event.type === "tool") {
      this.endText();
      const marker = event.phase === "started" ? "[>]" : event.phase === "completed" ? "[ok]" : "[x]";
      this.write(`${marker} ${event.name}\n`);
      if (event.phase === "failed" && event.error) this.write(`\x1b[2m  ${event.error}\x1b[0m\n`);
    } else if (event.type === "interaction") {
      this.endText();
      this.interaction = event.interaction;
      this.privateInputValues = [];
      this.renderInteraction(event.interaction);
    } else if (event.type === "interrupted") {
      this.endText();
      this.write("Career agent interrupted.\n");
    } else {
      this.endText();
      this.write(`Career agent error: ${event.error}\n`);
    }
  }

  private renderInteraction(interaction: CareerInteraction): void {
    if (interaction.kind === "user_input") {
      this.renderInputField(interaction);
    } else if (interaction.kind === "user_inputs") {
      this.write(`Input required for ${interaction.fields.length} application fields. Values stay outside the model.\n`);
      this.renderInputField(interaction.fields[0]!, 0, interaction.fields.length);
    } else if (interaction.kind === "answer_approval") {
      this.write(`${interaction.label}\n\n${interaction.draft}\n\n`);
      this.write('Type "yes" to approve, "no" to decline, or enter replacement text.\n');
    } else {
      this.write(`${interaction.prompt}\nCompleted fields: ${interaction.completedFields}\nScreenshot: ${interaction.screenshotPath}\n`);
      this.write('Type "yes" to authorize one submission attempt. Any other response declines.\n');
    }
  }

  private renderInputField(field: Extract<CareerInteraction, { kind: "user_input" }> | Extract<CareerInteraction, { kind: "user_inputs" }>["fields"][number], index?: number, total?: number): void {
    const progress = index !== undefined && total !== undefined ? ` [${index + 1}/${total}]` : "";
    this.write(`Input required${progress}: ${field.label} (${field.inputType})\n`);
    if (field.description) this.write(`${field.description}\n`);
    if (field.formatHint) this.write(`Format: ${field.formatHint}\n`);
    if (field.options.length) this.write(`Options: ${field.options.join(" | ")}\n`);
    this.write("Enter the value. It will be bound to the form without being returned to the model.\n");
  }

  private showHelp(): void {
    this.write("Ordinary messages go directly to the career agent.\nComplete any human takeover in the visible browser, then message the agent to continue.\n/help show help  /status show session state  /cancel end session  /resume resume the saved thread and browser  /exit quit\n");
  }

  private async resume(): Promise<void> {
    if (this.session) { this.write(`Career session is already active on thread ${this.session.threadId}.\n`); return; }
    this.session = await this.deps.resumeSession();
    this.write(`Resumed thread ${this.session.threadId} and re-inspected the current browser page.\n`);
  }

  private async showStatus(): Promise<void> {
    if (!this.session) { this.write("No career session has started.\n"); return; }
    const status = this.session.status();
    this.write(`${status.working ? "working" : status.waitingForInput ? "waiting for input" : "idle"} | ${status.mode} | thread ${status.threadId}${status.currentJobUrl ? ` | ${status.currentJobUrl}` : ""}\n`);
  }

  private async cancel(): Promise<void> {
    if (!this.session) { this.write("No career session has started.\n"); return; }
    this.write("Career session cancelled.\n");
    await this.close();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.session = undefined;
    this.interaction = undefined;
    this.privateInputValues = [];
    session?.interrupt();
    await session?.close().catch(() => {});
    this.rl?.close();
    this.finish?.();
    this.onExit?.();
  }

  private prompt(): void { if (!this.closed && !this.busy) this.rl?.prompt(); }
  private endText(): void { if (this.textOpen) { this.output.write("\n"); this.textOpen = false; } }
  private write(text: string): void { this.output.write(text); }
}
