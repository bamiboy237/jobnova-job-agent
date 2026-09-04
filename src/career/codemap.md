# src/career/

## Responsibility
Provides the unified conversational career agent that converses with the candidate, analyzes roles, resolves LinkedIn jobs, executes ATS applications, and pauses for private input and submission authorization.

## Design
- **Single Runtime Model Loop**: Operates as one Mastra thread (`careerAgent.ts`) with access to both resolution tools and guarded application tools, avoiding fragmented multi-agent transitions.
- **Normalized Event Streaming (`CareerEvent`)**: Generates asynchronous generator streams of typed events:
  - `status`: thinking/resuming indicator
  - `text_delta`: streamed assistant response chunks
  - `tool`: lifecycle telemetry (`started`, `completed`, `failed`)
  - `interaction`: suspension cards (`user_input`, `user_inputs`, `answer_approval`, `submission`)
- **Batched Private Suspensions**: `request_user_inputs` tool allows the agent to request multiple missing form values in a single suspension payload.
- **Session Lifecycle & Resource Management (`careerSession.ts`)**: Supports idle browser timeout, session closure, and cross-turn resumption.

## Flow
1. User sends message or job URL via web interface or CLI.
2. `CareerSession.sendMessage()` launches the Mastra agent loop.
3. Model converses or selects tools (`resolve_linkedin_job`, `inspect_current_page`, `execute_application_actions`).
4. If a field requires user guidance, model calls `request_user_input` or `request_user_inputs`, suspending the turn.
5. Client responds via `CareerSession.respond(values)`; agent receives opaque tokens and continues execution.
6. When application is complete, agent triggers submission confirmation interaction.

## Integration
- **Consumed by**: `src/server.ts` (`POST /api/chat*`), `src/apply/chatCli.ts`.
- **Depends on**: `src/mastra/`, `src/apply/`, `src/resolver/`, `src/browser/`.
