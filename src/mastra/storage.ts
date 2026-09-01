import { LibSQLStore } from "@mastra/libsql";

let storage: LibSQLStore | undefined;

export function getMastraStorage(): LibSQLStore {
  storage ??= new LibSQLStore({
    id: "job-agent-storage",
    url: process.env.MASTRA_DATABASE_URL || "file:./mastra.db",
    authToken: process.env.MASTRA_DATABASE_AUTH_TOKEN || undefined,
  });
  return storage;
}
