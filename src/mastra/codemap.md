# src/mastra/

## Responsibility
Agent runtime: model choice, thread memory, rate-limit retries, and history trimming.

## Design
- **Provider choice**: `model.ts` reads `LLM_PROVIDER` (`gemini`, `openai`, `deepseek`) and returns the model ids (Gemini by default).
- **History trimming**: `compactSupersededSnapshots` replaces old DOM dumps in `prepareStep` history with tombstones.
- **429 retries**: `rateLimitRetry.ts` detects rate limits (`isRateLimitError`) and backs off (`rateLimitRetryDelayMs`).
- **Thread memory**: `storage.ts` returns the LibSQL store (`getMastraStorage`) that keeps threads across restarts.

## Flow
1. `createResolverRuntime(modelConfig)` initializes `LibSqlStorage` and browser wrappers (`AgentBrowser` and `Stagehand`).
2. Tools are created with input/output validation via Zod schemas.
3. During execution, `prepareStep` intercepts messages and runs `compactSupersededSnapshots` to trim historic page dumps.
4. On rate limits, `isRateLimitError` triggers a backed-off retry.
5. On completion, structured output is validated against `ResolverAgentOutputSchema`.

## Integration
- **Consumed by**: `src/resolver/directResolver.ts`, `src/career/careerAgent.ts`.
- **Depends on**: `@mastra/core`, `@mastra/libsql`, `@mastra/agent-browser`, `@mastra/stagehand`, `src/browser/`.
