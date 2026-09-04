# src/server/

## Responsibility
Remembers resolver runs across restarts: `queued` → `running` → `completed` or `failed`.

## Design
- **`RunStore`**: reads and writes the `jobnova_runs` SQLite table (`initialize`, `create`, `markRunning`, `complete`, `fail`, `get`).
- **Lives on disk**: points at `MASTRA_DATABASE_URL`, so traces and results survive restarts.

## Flow
1. The server calls `store.initialize()` at startup.
2. `POST /api/runs` writes a `queued` record.
3. A background task marks it `running`, then `completed` or `failed` with the serialized `ResolverResult`.
4. `GET /api/runs/:id` reads the record back with elapsed runtime.

## Integration
- **Consumed by**: `src/server.ts`.
- **Depends on**: `@libsql/client`, `src/types.ts`.
