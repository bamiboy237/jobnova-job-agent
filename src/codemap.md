# src/

## Responsibility
Server entry, CLI entries, LinkedIn login helper, and shared schemas.

## Design
- **One process (`server.ts`)**: API routes, SSE streams, chat sessions in memory, screenshots, and the static `web/out/` bundle. `/api/*` needs `x-access-code`; `GET /` and `HEAD /` stay open for health probes.
- **Schemas (`types.ts`)**: Zod contracts for resolver input, results, and application outcomes.
- **Login helper (`auth.ts`)**: signs LinkedIn in on Browserbase or local Chrome and saves the session.

## Flow
- **Server**: `node dist/server.js` runs `createJobnovaServer()`, initializes `RunStore`, and listens on `PORT`.
- **Routes**: `/api/runs*` for resolver runs, `/api/chat*` for chat sessions, `/api/screenshots/*` for screenshots, `/api/eval` for checked-in evaluation data.
- **One-shot CLI**: `npm run resolve -- <url>` prints the result as JSON.

## Integration
- **Consumed by**: Railway deploy runtime (`node dist/server.js`), npm scripts (`npm run serve`, `npm run resolve`, `npm run auth`).
- **Dependencies**: `src/browser/`, `src/resolver/`, `src/apply/`, `src/career/`, `src/server/`.
