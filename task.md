- task:
  Build one conversational career agent, exposed through a thin Pi-like terminal client, that autonomously chooses guarded job-resolution and application tools while remaining able to converse before, during, and after job work.

- acceptance criteria:
  - `npm run apply:chat` immediately sends every ordinary message, including messages without a URL, to one career-agent Mastra thread.
  - The career agent is the only runtime model loop. LinkedIn resolution and application work are tools/capabilities in that conversation, not nested resolver or application agents.
  - The client renders incremental assistant text and Code Mode tool lifecycle events through one normalized event boundary, with tool updates keyed by tool-call ID.
  - The agent decides the next step. Tools enforce only local URL, privacy, exact-value binding, browser-mode, validation, lifecycle, and irreversible-action invariants.
  - Resolution mode exposes general navigation; application mode blocks generic navigation and mutations and retains compact inspection, value-free capabilities, bounded candidate lookup, typed sequential actions, and dynamic-page reinspection.
  - A general `user_input` tool can request typed structured input for a specific current control. Mastra suspends the tool, the client renders it, and guarded code binds and fills the exact response without returning its value to the model.
  - New secure factual answers are retained as extensible typed session context and can be reused on later jobs without disclosing values to the model. Durable cross-session persistence remains a later persistence ticket.
  - Generated free-form answers are shown in chat and require approval or editing before guarded code can enter them.
  - The agent requests submission only after guarded final validation. The user must confirm, and guarded code performs at most one final click and verifies the result.
  - One conversation can process several jobs sequentially while preserving the same Mastra thread and browser runtime and isolating each job ledger.
  - `/help`, `/status`, `/cancel`, and `/exit` are narrow client controls. Job outcomes do not close the career conversation; `/cancel`, exit, signals, and errors end the session and close resources exactly once.
  - Preserve the existing one-shot `applyJob` and CLI behavior (`npm run apply:test`, etc.).
  - Add focused tests for pre-URL conversation, one thread/runtime across sequential jobs, normalized events, opaque structured input, application-mode mutation guards, confirmation, cancellation, and cleanup; pass `npm test`, `npm run build`, `git diff --check`, and one no-submit live client proof.
