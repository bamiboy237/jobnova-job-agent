# src/career/

## Responsibility
The chat agent: talks through roles, opens job URLs, fills forms, and pauses for missing values and submit approval.

## Design
- **One thread**: `careerAgent.ts` runs a single Mastra loop with resolution and form tools, so no handoff between agents.
- **Typed events (`CareerEvent`)**: `status`, `text_delta`, `tool` (`started`, `completed`, `failed`), and `interaction` cards (`user_inputs`, `answer_approval`, `submission`) stream over SSE.
- **One ask for missing values**: `request_user_inputs` gathers up to 20 fields in a single pause.
- **Sessions (`careerSession.ts`)**: `createCareerSession()` opens a thread with a browser slot; idle browsers release after 10 minutes; `resumeCareerSession()` picks the thread back up. Each turn re-merges uploaded resume facts under the profile.

## Flow
1. User sends message or job URL via web interface or CLI.
2. `CareerSession.sendMessage()` launches the Mastra agent loop.
3. Model converses or picks tools (`open_supplied_job`, `enter_application_mode`, `inspect_current_page`, `execute_application_actions`).
4. For missing values the model calls `request_user_inputs`, pausing the turn.
5. The client answers through `CareerSession.respond(values)`; the turn resumes.
6. When application is complete, agent triggers submission confirmation interaction.

## Integration
- **Consumed by**: `src/server.ts` (`POST /api/chat*`), `src/apply/chatCli.ts`.
- **Depends on**: `src/mastra/`, `src/apply/`, `src/resolver/`, `src/browser/`.
