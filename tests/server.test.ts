import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createJobnovaServer } from "../src/server.js";
import type { CareerEvent, CareerSession } from "../src/career/careerSession.js";
import type { ResolverResult } from "../src/types.js";

const servers: Server[] = [];
const databases: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(databases.splice(0).map(async (database) => {
    await fs.rm(database, { force: true });
    await fs.rm(`${database}-shm`, { force: true });
    await fs.rm(`${database}-wal`, { force: true });
  }));
});

describe("Jobnova HTTP service", () => {
  it("gates APIs and persists a detached resolver result across a restart", async () => {
    let finish!: (result: ResolverResult) => void;
    const pendingResult = new Promise<ResolverResult>((resolve) => { finish = resolve; });
    const database = temporaryDatabase();
    const server = await createJobnovaServer({
      accessCode: "invite",
      databaseUrl: `file:${database}`,
      resolve: async () => pendingResult,
    });
    const baseUrl = await listen(server);

    const unauthorized = await fetch(`${baseUrl}/api/eval`);
    expect(unauthorized.status).toBe(401);

    const started = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": "invite" },
      body: JSON.stringify({ url: "https://www.linkedin.com/jobs/view/1234567890" }),
    });
    expect(started.status).toBe(202);
    const { runId } = await started.json() as { runId: string };

    const inProgress = await authorizedJson(`${baseUrl}/api/runs/${runId}`);
    expect(["queued", "running"]).toContain(inProgress.status);
    finish({
      success: true,
      company: "Example",
      jobTitle: "Engineer",
      linkedinUrl: "https://www.linkedin.com/jobs/view/1234567890",
      externalJobUrl: "https://example.com/jobs/engineer",
      runtimeMs: 25,
      trace: ["Validated"],
    });
    await waitFor(async () => (await authorizedJson(`${baseUrl}/api/runs/${runId}`)).status === "completed");
    await close(server);

    const restarted = await createJobnovaServer({ accessCode: "invite", databaseUrl: `file:${database}` });
    const restartedUrl = await listen(restarted);
    const persisted = await authorizedJson(`${restartedUrl}/api/runs/${runId}`);
    expect(persisted).toMatchObject({
      status: "completed",
      result: { success: true, company: "Example", jobTitle: "Engineer" },
      trace: ["Validated"],
      runtimeMs: 25,
    });
  });

  it("streams career events and ends the in-memory browser session", async () => {
    let closed = false;
    const fakeCareer: CareerSession = {
      threadId: "thread-1",
      sendMessage: () => events(
        { type: "status", status: "thinking", detail: "Working" },
        { type: "text_delta", delta: "Ready to help." },
      ),
      respond: () => events({ type: "text_delta", delta: "Continued." }),
      status: () => ({ threadId: "thread-1", mode: "conversation", working: false, waitingForInput: false }),
      interrupt: () => {},
      releaseBrowser: async () => {},
      close: async () => { closed = true; },
    };
    const server = await createJobnovaServer({
      accessCode: "invite",
      databaseUrl: `file:${temporaryDatabase()}`,
      createCareer: (async () => fakeCareer) as typeof import("../src/career/careerSession.js").createCareerSession,
    });
    const baseUrl = await listen(server);
    const created = await fetch(`${baseUrl}/api/chat`, { method: "POST", headers: { "x-access-code": "invite" } });
    const { sessionId } = await created.json() as { sessionId: string };

    const streamed = await fetch(`${baseUrl}/api/chat/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": "invite" },
      body: JSON.stringify({ text: "Hello" }),
    });
    const body = await streamed.text();
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('event: text_delta\ndata: {"type":"text_delta","delta":"Ready to help."}');
    expect(body).toContain('event: done\ndata: {"type":"done"}');

    const ended = await fetch(`${baseUrl}/api/chat/${sessionId}/end`, {
      method: "POST",
      headers: { "x-access-code": "invite" },
    });
    expect(ended.status).toBe(200);
    expect(closed).toBe(true);
  });
});

function temporaryDatabase(): string {
  const database = path.resolve(process.cwd(), `.server-test-${crypto.randomUUID()}.db`);
  databases.push(database);
  return database;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function authorizedJson(url: string): Promise<Record<string, any>> {
  const response = await fetch(url, { headers: { "x-access-code": "invite" } });
  return response.json() as Promise<Record<string, any>>;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met");
}

async function* events(...items: CareerEvent[]): AsyncGenerator<CareerEvent> {
  for (const item of items) yield item;
}
