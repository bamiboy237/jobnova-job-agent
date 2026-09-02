import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCareerSession, type CareerEvent, type CareerSession } from "./career/careerSession.js";
import { resolveDirectLinkedInJob } from "./resolver/directResolver.js";
import { collectEnvSecrets, safeError } from "./resolver/browserSafety.js";
import { ResolverInputSchema, type ResolverResult } from "./types.js";
import { RunStore } from "./server/runStore.js";

const MAX_LIVE_BROWSERS = 2;
const SESSION_IDLE_MS = 10 * 60 * 1_000;
const PUBLIC_DIRECTORY = path.resolve(process.cwd(), "web", "out");
const SCREENSHOTS_DIRECTORY = path.resolve(process.env.SCREENSHOTS_DIR || path.join(process.cwd(), "screenshots"));

interface WebCareerSession {
  career: CareerSession;
  browserLive: boolean;
  idleTimer?: NodeJS.Timeout;
}

export async function createJobnovaServer(options: {
  accessCode?: string;
  databaseUrl?: string;
  resolve?: typeof resolveDirectLinkedInJob;
  createCareer?: typeof createCareerSession;
} = {}) {
  const accessCode = options.accessCode ?? process.env.ACCESS_CODE;
  if (!accessCode) throw new Error("ACCESS_CODE is required");
  const store = new RunStore(options.databaseUrl);
  await store.initialize();
  const resolve = options.resolve ?? resolveDirectLinkedInJob;
  const createCareer = options.createCareer ?? createCareerSession;
  const sessions = new Map<string, WebCareerSession>();
  let liveBrowsers = 0;

  const reserveBrowser = (session?: WebCareerSession): boolean => {
    if (session?.browserLive) return true;
    if (liveBrowsers >= MAX_LIVE_BROWSERS) return false;
    liveBrowsers += 1;
    if (session) session.browserLive = true;
    return true;
  };

  const releaseBrowser = async (session: WebCareerSession) => {
    if (!session.browserLive) return;
    session.browserLive = false;
    liveBrowsers = Math.max(0, liveBrowsers - 1);
    await session.career.releaseBrowser();
  };

  const scheduleIdleRelease = (session: WebCareerSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(async () => {
      if (session.career.status().working) {
        scheduleIdleRelease(session);
        return;
      }
      await releaseBrowser(session);
    }, SESSION_IDLE_MS);
    session.idleTimer.unref();
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/") && request.headers["x-access-code"] !== accessCode) {
        return json(response, 401, { error: "Invalid access code" });
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const input = ResolverInputSchema.safeParse({ linkedinUrl: (await readJson(request)).url });
        if (!input.success) return json(response, 400, { error: input.error.errors.map((error) => error.message).join("; ") });
        if (!reserveBrowser()) return busy(response);
        const runId = randomUUID();
        try {
          await store.create({ id: runId, status: "queued", linkedinUrl: input.data.linkedinUrl, createdAt: Date.now() });
        } catch (error) {
          liveBrowsers = Math.max(0, liveBrowsers - 1);
          throw error;
        }
        void (async () => {
          const startedAt = Date.now();
          try {
            await store.markRunning(runId, startedAt);
            const result = await resolve(input.data);
            await store.complete(runId, result, Date.now());
          } catch (error) {
            const result: ResolverResult = {
              success: false,
              linkedinUrl: input.data.linkedinUrl,
              error: safeError(error, collectEnvSecrets()),
              runtimeMs: Date.now() - startedAt,
              trace: ["Resolver service stopped unexpectedly"],
            };
            await store.fail(runId, result, Date.now());
          } finally {
            liveBrowsers = Math.max(0, liveBrowsers - 1);
          }
        })();
        return json(response, 202, { runId });
      }

      const runMatch = request.method === "GET" ? url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)$/) : undefined;
      if (runMatch) {
        const run = await store.get(runMatch[1]);
        if (!run) return json(response, 404, { error: "Run not found" });
        const result = run.result ? publicResult(run.result) : undefined;
        return json(response, 200, {
          status: run.status,
          ...(result ? { result } : {}),
          trace: run.result?.trace ?? [],
          runtimeMs: run.result?.runtimeMs ?? (run.startedAt ? Date.now() - run.startedAt : 0),
          screenshotUrls: screenshotUrls(run.result?.screenshots),
        });
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/screenshots/")) {
        return serveScreenshot(url.pathname.slice("/api/screenshots/".length), response);
      }

      if (request.method === "GET" && url.pathname === "/api/eval") {
        try {
          const evaluation = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "data/evaluation.json"), "utf8"));
          return json(response, 200, evaluation);
        } catch {
          return json(response, 200, { summary: null, cases: [] });
        }
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const career = await createCareer(undefined, { persist: false });
        const sessionId = randomUUID();
        sessions.set(sessionId, { career, browserLive: false });
        return json(response, 201, { sessionId });
      }

      const messageMatch = request.method === "POST"
        ? url.pathname.match(/^\/api\/chat\/([a-f0-9-]+)\/(message|respond)$/)
        : undefined;
      if (messageMatch) {
        const session = sessions.get(messageMatch[1]);
        if (!session) return json(response, 404, { error: "Chat session not found" });
        if (session.career.status().working) return json(response, 409, { error: "Career agent is already working" });
        const body = await readJson(request);
        const value = messageMatch[2] === "message" ? body.text : body.value;
        if (typeof value !== "string" || !value.trim()) return json(response, 400, { error: "A non-empty value is required" });
        if (!reserveBrowser(session)) return busy(response);
        scheduleIdleRelease(session);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const events = messageMatch[2] === "message" ? session.career.sendMessage(value) : session.career.respond(value);
        for await (const event of events) writeSse(response, event.type, event);
        writeSse(response, "done", { type: "done" });
        response.end();
        scheduleIdleRelease(session);
        return;
      }

      const endMatch = request.method === "POST" ? url.pathname.match(/^\/api\/chat\/([a-f0-9-]+)\/end$/) : undefined;
      if (endMatch) {
        const session = sessions.get(endMatch[1]);
        if (!session) return json(response, 404, { error: "Chat session not found" });
        sessions.delete(endMatch[1]);
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.browserLive) {
          session.browserLive = false;
          liveBrowsers = Math.max(0, liveBrowsers - 1);
        }
        await session.career.close();
        return json(response, 200, { ended: true });
      }

      if (request.method === "GET") return serveStatic(url.pathname, response);
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 500, { error: safeError(error, collectEnvSecrets()) });
    }
  });

  server.on("close", () => {
    for (const session of sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      void session.career.close();
    }
  });
  return server;
}

function publicResult(result: ResolverResult): Omit<ResolverResult, "screenshots"> {
  const { screenshots: _screenshots, ...safe } = result;
  return safe;
}

function screenshotUrls(screenshots: string[] | undefined): string[] {
  return (screenshots ?? [])
    .map((screenshot) => path.resolve(screenshot))
    .filter((screenshot) => path.dirname(screenshot) === SCREENSHOTS_DIRECTORY)
    .map((screenshot) => `/api/screenshots/${encodeURIComponent(path.basename(screenshot))}`);
}

async function serveScreenshot(requestedName: string, response: ServerResponse): Promise<void> {
  const decoded = decodeURIComponent(requestedName);
  if (decoded !== path.basename(decoded) || !decoded.endsWith(".png")) return json(response, 404, { error: "Screenshot not found" });
  const target = path.resolve(SCREENSHOTS_DIRECTORY, decoded);
  if (path.dirname(target) !== SCREENSHOTS_DIRECTORY) return json(response, 404, { error: "Screenshot not found" });
  try {
    const body = await fs.readFile(target);
    response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=300" });
    response.end(body);
  } catch {
    return json(response, 404, { error: "Screenshot not found" });
  }
}

async function serveStatic(requestPath: string, response: ServerResponse): Promise<void> {
  const relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  if (relative !== path.normalize(relative) || relative.startsWith("..") || path.isAbsolute(relative)) {
    return json(response, 404, { error: "Not found" });
  }
  const target = path.resolve(PUBLIC_DIRECTORY, relative);
  if (!target.startsWith(`${PUBLIC_DIRECTORY}${path.sep}`)) return json(response, 404, { error: "Not found" });
  try {
    const body = await fs.readFile(target);
    const extension = path.extname(target);
    const contentType = extension === ".html" ? "text/html; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : extension === ".js" ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(body);
  } catch {
    return json(response, 404, { error: "Not found" });
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

function writeSse(response: ServerResponse, event: string, data: CareerEvent | { type: "done" }): void {
  if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function busy(response: ServerResponse): void {
  json(response, 429, { error: "All browser sessions are busy. Try again in a few minutes." });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000);
  const server = await createJobnovaServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`[SERVER] Jobnova listening on port ${port}`);
  });
}
