# src/apply/

## Responsibility
Implements the autonomous ATS application pipeline, providing form understanding, guarded form filling, candidate profile resolution, batch action execution, resume upload, and human-in-the-loop submission authorization.

## Design
- **Guarded Action Pattern**: Browser mutations are strictly decoupled from LLM reasoning. The model receives value-free semantic refs (`@ref1`, `@ref2`) and requests actions via keys (`personal.email`); guarded TypeScript code performs the actual DOM input without returning values to context (`generalBrowserTools.ts`, `generalSafety.ts`).
- **Batch Action Execution (`execute_application_actions`)**: Groups up to 20 sequential DOM actions (`fill_fact`, `select_fact`, `upload_approved_resume`, etc.) into one model step with `stopOnError` support.
- **Candidate Data Privacy & Isolation**:
  - `candidateCatalog.ts` & `generalFacts.ts`: Resolves approved profile facts into typed values in memory.
  - Opaque answer tokens: user inputs provided interactively are held in private state and bound to controls via opaque tokens.
- **Run Ledger (`runLedger.ts`)**: Tracks completed fields and prevents redundant re-fills.
- **One-Click Submission Invariant**: Submission requires full form validation, screenshot capture (`applicationArtifacts.ts`), explicit human approval, and exactly one click without retry.

## Flow
1. Receives target ATS application URL (e.g. Lever, Greenhouse).
2. `pageInspection.ts` analyzes DOM form controls and produces sanitized `PageControl` snapshots with stable `@ref` handles.
3. Model inspects form state and calls `execute_application_actions` to batch-populate known candidate facts and approved answers.
4. For unknown/private fields, agent requests structured input without exposing entered values to prompt logs.
5. Uploads approved resume via file input handling.
6. Conducts pre-submission audit; captures full-page screenshot.
7. Requests user authorization before executing the final single submission click.

## Integration
- **Consumed by**: `src/career/careerAgent.ts`, `src/apply/cli.ts`, `src/apply/chatCli.ts`.
- **Depends on**: `src/browser/`, `src/types.ts`, `playwright-core`, `@mastra/core`.
