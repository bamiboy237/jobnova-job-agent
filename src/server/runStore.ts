import { createClient, type Client } from "@libsql/client";
import type { ResolverResult } from "../types.js";

export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface StoredRun {
  id: string;
  status: RunStatus;
  linkedinUrl: string;
  result?: ResolverResult;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export class RunStore {
  private readonly client: Client;

  constructor(url = process.env.MASTRA_DATABASE_URL || "file:./mastra.db") {
    this.client = createClient({
      url,
      authToken: process.env.MASTRA_DATABASE_AUTH_TOKEN || undefined,
    });
  }

  async initialize(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS jobnova_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        linkedin_url TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER
      )
    `);
  }

  async create(run: StoredRun): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO jobnova_runs
        (id, status, linkedin_url, created_at)
        VALUES (?, ?, ?, ?)`,
      args: [run.id, run.status, run.linkedinUrl, run.createdAt],
    });
  }

  async markRunning(id: string, startedAt: number): Promise<void> {
    await this.client.execute({
      sql: "UPDATE jobnova_runs SET status = 'running', started_at = ? WHERE id = ?",
      args: [startedAt, id],
    });
  }

  async complete(id: string, result: ResolverResult, completedAt: number): Promise<void> {
    await this.client.execute({
      sql: "UPDATE jobnova_runs SET status = ?, result_json = ?, completed_at = ? WHERE id = ?",
      args: [result.success ? "completed" : "failed", JSON.stringify(result), completedAt, id],
    });
  }

  async fail(id: string, result: ResolverResult, completedAt: number): Promise<void> {
    await this.complete(id, result, completedAt);
  }

  async get(id: string): Promise<StoredRun | undefined> {
    const result = await this.client.execute({
      sql: "SELECT * FROM jobnova_runs WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: String(row.id),
      status: row.status as RunStatus,
      linkedinUrl: String(row.linkedin_url),
      result: row.result_json ? JSON.parse(String(row.result_json)) as ResolverResult : undefined,
      createdAt: Number(row.created_at),
      startedAt: row.started_at === null ? undefined : Number(row.started_at),
      completedAt: row.completed_at === null ? undefined : Number(row.completed_at),
    };
  }
}
