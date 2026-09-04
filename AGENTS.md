# Agent Guidelines

This document defines engineering standards, communication rules, operational commands, and safety invariants for autonomous coding agents working in this repository.

## Progress updates

Provide clear, concise progress updates to the user:

- Send a short status update before you start work.
- If a task takes longer than one minute, send an update at least every 60 seconds.
- State the goal, completed work, rationale, and next step.
- Use plain English. Avoid unexplained jargon and internal labels.
- Keep each update between two and four sentences.
- Do not paste raw terminal logs. Summarize test and build outputs directly.
- When you finish a task, report changed files, passed checks, and any remaining risks.

## Interactive alignment (Always grill me)

Always align on design, scope, and deliverables before writing code or creating files:

- **Never assume requirements or guess deliverables:** Do not guess ambiguous prompts, create unrequested files, or begin multi-file changes without explicit alignment.
- **Always grill the user with `ask_question`:** Whenever a task involves design forks, scope ambiguity, or deliverable options, use `ask_question` with focused, actionable choices so the user steers the work.
- **Confirm exact boundaries:** Explicitly confirm what files will be created, modified, or deleted before taking action.
- **Actively apply specialized global skills:**
  - `coding-standards`: Make the smallest complete change; write self-explaining code; avoid speculative abstractions; preserve compatibility.
  - `technical-writing`: Follow Diátaxis modes; write in Google developer style; apply STE (one thought per sentence); enforce Global English.
  - `verification-planning`: Plan test evidence before modifying behavior; test at stable observable interfaces.
  - `design`: Use a monochrome foundation first; enforce high information density; use zero emojis in technical docs.

## Project structure

- `src/server.ts`: Single-process HTTP server. Serves API endpoints, Server-Sent Events, and static Next.js assets.
- `src/apply/`: Guarded application engine. Handles DOM control inspection, candidate profile resolution, and batch action execution.
- `src/career/`: Unified conversational career agent. Coordinates user chat, LinkedIn resolution, and application tools.
- `src/resolver/`: LinkedIn job resolver. Performs deterministic DOM link extraction, Stagehand fallback, and destination invariant checks.
- `src/mastra/`: Mastra runtime configuration. Manages LLM provider models, LibSQL storage, and context snapshot compaction.
- `src/browser/`: CDP browser session manager. Handles remote Browserbase connections and local Chrome debugging.
- `src/server/`: SQLite database store (`RunStore`) for detached runs and status lifecycles.
- `web/`: Next.js single-page application and custom Vercel AI SDK streaming transport.
- `tests/`: Automated unit and integration test suite.

## Development commands

- `npm install`: Install project dependencies.
- `npm run build`: Compile TypeScript backend (`dist/`) and Next.js frontend (`web/out/`).
- `npm test`: Run automated tests using Vitest.
- `npm run serve`: Start the production HTTP server on port 3000.
- `npm run resolve -- <url>`: Run one-shot direct LinkedIn job resolution from the terminal.
- `npm run apply:chat`: Launch the terminal-based interactive career chat interface.
- `npm run auth`: Authenticate a persistent browser context with LinkedIn credentials.

Always run `npm test` before declaring non-trivial code changes complete.

## Safety and operational invariants

Adhere strictly to these four architectural invariants:

1. **Candidate data isolation:** Keep candidate secrets out of model prompts and tool return values. The model receives value-free references (`@ref`) and semantic fact keys. Guarded TypeScript functions bind candidate values in memory.
2. **One-click submission:** Automated retry of final form submission is prohibited. The agent must run a pre-submission DOM audit, capture a full-page screenshot, and pause for explicit human authorization before executing the final click.
3. **Strict destination validation:** Candidate destinations must be HTTPS and external to LinkedIn. Reject login walls, registration prompts, and generic search feeds.
4. **Browser concurrency ceiling:** Maintain at most two concurrent live browser sessions. Enforce a 10-minute idle release timer to release remote browser allocations.

## Coding style and conventions

- **Language:** Use TypeScript with strict null checks enabled.
- **Modularity:** Separate pure domain logic from browser automation and route handlers.
- **Error handling:** Wrap external API and CDP failures in structured, sanitized errors. Redact environment keys from exception messages using `src/resolver/browserSafety.ts`.
- **Token management:** Compact historical DOM snapshots before each step in multi-turn browser loops using `compactSupersededSnapshots`.

## Testing guidelines

- Write tests using Vitest.
- Keep tests fast and isolated. Use `os.tmpdir()` for temporary SQLite test databases.
- Integration tests for HTTP routes must verify both `GET` and `HEAD` methods to protect container health checks.
- Mock external network services and remote browser instances in automated suites.

## Repository Map

A full codemap is available at [`codemap.md`](codemap.md) in the project root. An interactive visual guide is available at [`docs/interactive_codemap.html`](docs/interactive_codemap.html).

Before working on any task, read [`codemap.md`](codemap.md) to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.
