# web/

## Responsibility
Container directory for the Next.js frontend application, managing static export configuration, client TypeScript settings, page components, and streaming transport libraries.

## Design
- **Static Export Configuration (`next.config.ts`)**: Configured with `output: "export"`, exporting static HTML, CSS, and JS bundles to `web/out/` during `npm run build:web`.
- **Decoupled Client**: The web application communicates purely over HTTP/SSE with the backend server, allowing it to be compiled independently and served directly from memory or disk by `src/server.ts`.

## Subdirectories
| Directory | Responsibility | Map |
| :--- | :--- | :--- |
| [`web/app/`](file:///Users/king/Desktop/takehome/web/app/codemap.md) | Next.js App Router root containing page layouts, chat workspace, and resolver card. | [View Map](app/codemap.md) |
| [`web/lib/`](file:///Users/king/Desktop/takehome/web/lib/codemap.md) | Client transport layer bridging SSE career events to Vercel AI SDK UI chunks. | [View Map](lib/codemap.md) |

## Integration
- **Build Output**: Compiles into `web/out/`.
- **Server**: Served statically by `serveStatic` in `src/server.ts`.
