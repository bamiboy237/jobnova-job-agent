# src/resolver/

## Responsibility
Extracts and resolves external company/ATS application URLs from raw LinkedIn job postings, providing deterministic navigation, LLM-based fallback, destination validation, and runtime secret redaction.

## Design
- **Pipeline / Controller Pattern**: `resolveDirectLinkedInJob` coordinates input parsing (`ResolverInputSchema`), browser initialization, deterministic DOM inspection, Mastra agent execution, destination validation, and snapshot compaction.
- **Deterministic-First, LLM-Fallback**: Prefers zero-token DOM extraction of external apply links before engaging Stagehand or Mastra LLM reasoning.
- **Destination Invariant Validation**: `validateDestination` applies strict deterministic rules to candidate URLs:
  - Must be valid HTTPS external URL (strictly non-LinkedIn).
  - Rejects login walls, signup redirects, and auth checkpoints.
  - Recognizes known ATS canonical patterns (Lever, Greenhouse, Workday, Ashby, Taleo, etc.).
- **Redaction & Safety**: `browserSafety.ts` dynamically aggregates environment secrets (`collectEnvSecrets`) and scrubs them from error messages and logs (`safeError`).

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
