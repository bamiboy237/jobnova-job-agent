# web/

## Responsibility
The Next.js chat UI, built to static files and served by the server.

## Design
- **Static export (`next.config.ts`)**: `output: "export"` writes the bundle to `web/out/` on `npm run build:web`.
- **Talks HTTP/SSE only**: the UI compiles on its own and `src/server.ts` serves the result.

## Subdirectories
| Directory | Responsibility | Map |
| :--- | :--- | :--- |
| [`web/app/`](app/codemap.md) | Chat workspace, access gate, and resolver card. | [View Map](app/codemap.md) |
| [`web/lib/`](lib/codemap.md) | SSE career events to AI SDK message chunks. | [View Map](lib/codemap.md) |

## Integration
- **Build Output**: Compiles into `web/out/`.
- **Server**: Served statically by `serveStatic` in `src/server.ts`.
