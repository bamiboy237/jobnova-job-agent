# src/resolver/

## Responsibility
Turns a raw LinkedIn job post into an employer or ATS application URL, with destination checks and secret redaction.

## Design
- **DOM first, Stagehand on ambiguity**: reads apply links from the page before running model reasoning.
- **Destination checks**: `validateDestination` accepts a URL only when it uses HTTPS, leaves LinkedIn, points at a job page (not a generic careers page), and matches the company and role with visible evidence. Login walls and search pages fail.
- **Secret redaction**: `browserSafety.ts` gathers live secrets (`collectEnvSecrets`) and strips them from errors and logs (`safeError`).

## Flow
1. Receives `{ linkedinUrl }` and initializes Mastra agent runtime and browser CDP session.
2. Navigates to LinkedIn job post; inspects DOM for direct `Apply on company website` links.
3. If unambiguous external ATS URL is found, follows and captures destination.
4. If ambiguous or multi-step, invokes Mastra resolver agent with Stagehand browser tools.
5. Captures viewport screenshot and timing metrics.
6. Validates candidate destination via `validateDestination()`.
7. Returns structured `ResolverResult` with metadata, trace, and safe error messages.

## Integration
- **Consumed by**: `src/index.ts` (CLI), `src/server.ts` (`POST /api/runs`), `src/career/careerSession.ts`.
- **Depends on**: `src/mastra/`, `src/browser/`, `src/types.ts`.
