# src/apply/

## Responsibility
Fills ATS application forms from the candidate profile, asks for what the profile lacks, and stops for human approval before submitting.

## Design
- **Values stay in TypeScript**: the model sees `@ref` handles and fact keys (`personal.email`); guarded code writes the real values without returning them (`generalBrowserTools.ts`).
- **Batch writes (`execute_application_actions`)**: up to 20 DOM writes (`fill_fact`, `select_fact`, `upload_approved_resume`, and others) in one model turn, with `stopOnError=false` for independent fields.
- **Private answers**: `candidateCatalog.ts` and `generalFacts.ts` hold approved facts in memory; interactive answers stay in private state and bind to controls without entering logs.
- **Run ledger (`runLedger.ts`)**: records filled fields so none fills twice.
- **Resume upload**: `POST /api/files` saves the PDF as the approved copy; `resumeFacts.ts` parses labeled contact lines into trusted fact keys only, and each chat turn merges them under the profile (profile wins).
- **Challenge grace period**: on a challenge page the controller gives Browserbase up to 45 seconds (15-second polls) to solve it before handing control to you. Local runs hand over at once.
- **One submit click**: submission needs a passing audit, a screenshot (`applicationArtifacts.ts`), your approval, and exactly one click with no retry.

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
