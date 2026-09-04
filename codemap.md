# Repository Atlas: Jobnova

## Project Responsibility
Jobnova is an autonomous career search and applicant tracking system (ATS) application agent. It resolves opaque LinkedIn job postings to verified company and ATS application URLs, guides candidates through conversational exploration, inspects application forms, completes fields with candidate data, prompts privately for sensitive inputs, and enforces explicit human confirmation before final form submission.

## System Entry Points
- `src/server.ts`: Single-process production HTTP server. Handles REST endpoints (`/api/runs`, `/api/chat`), Server-Sent Events, static Next.js assets from `web/out/`, and container health probes.
- `src/index.ts`: Command-line interface for one-shot direct LinkedIn job resolution (`npm run resolve -- <url>`).
- `src/apply/chatCli.ts`: Interactive terminal career agent chat client (`npm run apply:chat`).
- `src/apply/cli.ts`: Direct form application CLI supporting dry-run test and submission modes (`npm run apply:test`, `npm run apply:submit`).
- `src/auth.ts`: Browser session authenticator saving persistent LinkedIn login cookies (`npm run auth`).
- `docs/interactive_codemap.html`: Interactive visual codemap and architectural onboarding guide.
- `package.json`: Project scripts, build targets, and runtime dependencies.
- `railway.json` & `Procfile`: Production container configuration for Railway Nixpacks.

## Architecture & Design Patterns
- **Value-Free DOM Handles:** `pageInspection.ts` parses form elements and assigns synthetic identifiers (such as `@first` or `@email`). Language model prompts receive only these value-free handles and semantic keys, keeping candidate secrets out of model context.
- **Guarded Action Execution:** Pure TypeScript functions bind real candidate data in memory (`candidateCatalog.ts`). DOM inputs run through guarded tools (`generalBrowserTools.ts`) without returning entered values in tool responses.
- **Batch Action Execution:** `execute_application_actions` groups up to 20 sequential DOM operations into a single model step. Supports fail-stop or independent error modes to reduce latency.
- **Consolidated User Input Suspension:** When form fields cannot be resolved from the candidate profile, `request_user_inputs` suspends execution once for 2 to 20 fields. The client displays one consolidated form card. User inputs return as opaque tokens.
- **Deterministic-First Resolution:** The LinkedIn resolver checks page DOM anchors deterministically before engaging language models. Stagehand fallback runs only when page structure or redirects are ambiguous.
- **Context Snapshot Compaction:** `compactSupersededSnapshots` intercepts messages in Mastra's `prepareStep` hook. It replaces historical DOM dumps with lightweight tombstones, preventing token accumulation across multi-turn sessions.
- **One-Click Submission Invariant:** Autonomous retries of final form submissions are prohibited. The engine conducts a pre-submission DOM audit, captures a full-page screenshot, and requires explicit user confirmation.
- **Custom Streaming Transport:** `JobnovaTransport` bridges Mastra Server-Sent Events into typed Vercel AI SDK `UIMessage` parts (text deltas, activity chips, and interactive cards).

## Directory Map (Aggregated)

| Directory | Responsibility Summary | Detailed Map |
| :--- | :--- | :--- |
| [`src/`](src/codemap.md) | Central server entrypoint, shared schemas, authentication utility, and CLI dispatchers. | [View Map](src/codemap.md) |
| [`src/resolver/`](src/resolver/codemap.md) | LinkedIn destination extraction, deterministic link inspection, Stagehand fallback, and secret redaction. | [View Map](src/resolver/codemap.md) |
| [`src/apply/`](src/apply/codemap.md) | Autonomous form engine, DOM control inspection, candidate catalog, batch actions, and submission audit. | [View Map](src/apply/codemap.md) |
| [`src/career/`](src/career/codemap.md) | Unified conversational career agent, session manager, idle browser release, and SSE event generation. | [View Map](src/career/codemap.md) |
| [`src/mastra/`](src/mastra/codemap.md) | Mastra runtime configuration, model provider routing, LibSQL SQLite storage, and snapshot compaction. | [View Map](src/mastra/codemap.md) |
| [`src/browser/`](src/browser/codemap.md) | CDP browser session management for remote Browserbase and local Chrome debugging environments. | [View Map](src/browser/codemap.md) |
| [`src/server/`](src/server/codemap.md) | SQLite Data Access Object (`RunStore`) managing detached job resolution run states and lifecycles. | [View Map](src/server/codemap.md) |
| [`web/`](web/codemap.md) | Next.js frontend root container, TypeScript configuration, and static export build pipeline. | [View Map](web/codemap.md) |
| [`web/app/`](web/app/codemap.md) | Minimal single-page chat interface, access code gate, quick resolve drawer, and interaction cards. | [View Map](web/app/codemap.md) |
| [`web/lib/`](web/lib/codemap.md) | Custom Vercel AI SDK streaming transport translating Server-Sent Events to UI message parts. | [View Map](web/lib/codemap.md) |

## End-to-End Execution Flows

1. **LinkedIn Job Resolution:**
   - Client calls `POST /api/runs` with a LinkedIn URL.
   - `RunStore` creates a record in `queued` status.
   - Background task transitions status to `running`.
   - `directResolver.ts` checks the DOM for direct external apply links.
   - If ambiguous, Stagehand observes page elements and navigates external redirects.
   - `validateDestination.ts` checks that the candidate URL is HTTPS, external to LinkedIn, and matches known ATS patterns.
   - `RunStore` updates status to `completed` or `failed` with serialized `ResolverResult`.

2. **Conversational Career Agent & Form Filling:**
   - User sends a message via `POST /api/chat/:id/message`.
   - `CareerSession` activates the Mastra career agent thread.
   - `compactSupersededSnapshots` prunes past DOM snapshots from message history.
   - Agent invokes `resolve_linkedin_job` or navigates directly to the target application URL.
   - `pageInspection.ts` extracts form controls and assigns synthetic `@ref` handles.
   - Agent calls `execute_application_actions` to batch up to 20 inputs using profile facts.
   - For unknown fields, agent calls `request_user_inputs`. The turn pauses until the candidate submits the card.
   - Engine conducts pre-submission audit, saves a full-page screenshot, and requests human confirmation.
   - Candidate clicks confirmation button. The engine performs the single final submission click.

## Safety and Operational Invariants

1. **Candidate Data Isolation:** Model prompts receive only structural handles (`@ref`) and semantic fact keys. Personal values are bound in memory within pure TypeScript functions and never returned in tool responses.
2. **One-Click Submission:** Autonomous retries of final form submissions are prohibited. The engine requires a pre-submission DOM audit, a full-page screenshot, and one explicit human confirmation.
3. **Strict Destination Validation:** Candidate URLs must use HTTPS and point outside LinkedIn. Reject login walls, registration prompts, and generic search listings.
4. **Browser Concurrency Ceiling:** Maintain at most two concurrent live browser sessions. Enforce a 10-minute idle release timer to release remote browser allocations.
