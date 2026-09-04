# src/mastra/

## Responsibility
Configures and orchestrates the Mastra agent framework, managing LLM provider selection, persistent memory storage, browser tool wrappers, rate-limit retry policies, and context window snapshot compaction.

## Design
- **Mastra Agent Configuration**: Instantiates `Agent` with toolkits for browser interaction, structured JSON schemas, and thread memory.
- **Provider Factory**: `model.ts` maps `LLM_PROVIDER` (`gemini`, `openai`, `deepseek`) to appropriate model identifiers (`google/gemini-3.6-flash`, `openai/gpt-5.6-luna`) and provider options (e.g. reasoning/thinking levels).
- **Snapshot Compaction (Token Optimization)**: `compactSupersededSnapshots` rewrites past step history in `prepareStep` to stub out obsolete `browser_snapshot` and `inspect_current_page` payloads, preventing explosive token burn across multi-turn sessions.
- **Resilience / Fault Tolerance**: `rateLimitRetry.ts` intercepts HTTP 429/rate-limit exceptions and performs exponential backoff.
- **LibSQL Storage**: `storage.ts` provides LibSQL-backed thread persistence (`LibSqlStorage`).

## Flow
1. `createResolverRuntime(modelConfig)` initializes `LibSqlStorage` and browser wrappers (`AgentBrowser` and `Stagehand`).
2. Tools are created with input/output validation via Zod schemas.
3. During execution, `prepareStep` intercepts messages and runs `compactSupersededSnapshots` to trim historic page dumps.
4. If the LLM hits provider rate limits, `withRateLimitRetry` retries with backoff.
5. On completion, structured output is validated against `ResolverAgentOutputSchema`.

## Integration
- **Consumed by**: `src/resolver/directResolver.ts`, `src/career/careerAgent.ts`.
- **Depends on**: `@mastra/core`, `@mastra/libsql`, `@mastra/agent-browser`, `@mastra/stagehand`, `src/browser/`.
