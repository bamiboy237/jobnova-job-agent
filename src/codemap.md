# src/

## Responsibility
Root application source containing production HTTP server, CLI entrypoints, authentication tools, and core data contract schemas.

## Design
- **Single-Process HTTP Service (`server.ts`)**: Combines API routing, SSE streaming, in-memory chat session caching, screenshot serving, and static Next.js export delivery (`web/out/`) in one Node.js process.
- **Access Gating & Health Probing**: Requires `x-access-code` header for `/api/*` routes; provides open `GET /` and `HEAD /` routes for Railway container health probes.
- **Contract Schemas (`types.ts`)**: Defines Zod validation schemas and TypeScript interfaces for resolver inputs, application artifacts, and evaluation metrics.
- **Authentication Gateway (`auth.ts`)**: Helper script for establishing interactive LinkedIn sessions in Browserbase or local Chrome contexts.

## Flow
- **HTTP Server**: `node dist/server.js` initializes `createJobnovaServer()`, runs `RunStore.initialize()`, and listens on `0.0.0.0:${PORT}`.
- **API Routing**: Dispatches `/api/runs*` to `RunStore` and resolver, `/api/chat*` to `CareerSession`, `/api/screenshots/*` to screenshot storage, and `/api/eval` to checked-in evaluation data.
- **One-Shot CLI**: `tsx src/index.ts <url>` validates input, runs `resolveDirectLinkedInJob`, and outputs formatted JSON to stdout.

## Integration
- **Consumed by**: Railway deploy runtime (`node dist/server.js`), npm scripts (`npm run serve`, `npm run resolve`, `npm run auth`).
- **Dependencies**: `src/browser/`, `src/resolver/`, `src/apply/`, `src/career/`, `src/server/`.
