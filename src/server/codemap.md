# src/server/

## Responsibility
Manages persistent state and storage for detached resolver runs and asynchronous job evaluation lifecycles.

## Design
- **Data Access Object (DAO) Pattern**: `RunStore` encapsulates LibSQL/SQLite database operations for the `jobnova_runs` table.
- **State Machine**: Tracks run progression across four distinct statuses: `queued` → `running` → `completed` | `failed`.
- **Durable Across Restarts**: Preserves resolver traces, duration metrics, and destination results on disk or persistent volume (`MASTRA_DATABASE_URL`).

## Flow
1. Server starts and calls `store.initialize()`, creating `jobnova_runs` schema if not exists.
2. `POST /api/runs` creates a `queued` record with UUID.
3. Background worker marks the run `running` with `startedAt` timestamp.
4. On resolver resolution, updates status to `completed` or `failed` with JSON serialized `ResolverResult`.
5. `GET /api/runs/:id` retrieves stored run details and calculates elapsed runtime.

## Integration
- **Consumed by**: `src/server.ts`.
- **Depends on**: `@libsql/client`, `src/types.ts`.
