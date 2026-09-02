# Job application agent

A job agent that resolves LinkedIn job URLs and includes a general, safety-bounded application controller.

## Status

The resolver and general application controller use Mastra browser agents. The current architecture passes the TypeScript build, focused tests, live resolver checks, and a local Lever no-submit check.

- The Mastra agent owns the browser tool loop.
- Stagehand extracts page meaning and observes likely actions.
- AgentBrowser performs navigation, snapshots, clicks, and screenshots.
- TypeScript preserves candidates and makes the final validation decision.
- Browserbase remains the production browser. Local Chrome supports development verification.

- `plan.md` contains the ticket backlog and architecture.
- `task.md` contains the only active implementation task.
- `issues.md` contains signed work notes, blockers, and review findings.
- `AGENTS.md` defines the rules for planning, implementation, and review.

## Product flow

The take-home has two core capabilities:

```text
Project 2
LinkedIn URL
→ inspect LinkedIn
→ resolve matching external job / ATS page
→ return result

Project 3
ATS application
→ load candidate data
→ fill form
→ upload resume
→ validate
→ submit
→ verify result
```

These are built separately first, then connected into one product.

Final flow:

```text
LinkedIn URL
→ resolve external job source
→ optionally apply
→ record result
```

## Stack

- TypeScript
- Mastra
- OpenAI `gpt-5.6-luna` with medium reasoning
- Gemini 3.6 Flash with medium dynamic thinking as the primary runtime model
- DeepSeek V4 Flash Vision as an experimental fallback
- Browserbase remote Chromium
- Stagehand
- `agent-browser`
- Zod
- Railway
- LibSQL-backed SQLite for persistent Mastra memory

## Browser architecture

Browserbase provides the remote Chromium session used by the deployed product.

```text
Mastra agent
    ↓
Stagehand extract/observe
    ↓
AgentBrowser snapshot/action
    ↓
Browserbase
    ↓
LinkedIn / company sites / Lever
```

Use Stagehand for page understanding and action proposals.

Use AgentBrowser for navigation, accessibility snapshots, precise actions, form interaction, validation, submission, and screenshots.

Both providers connect to one CDP session and run sequentially. Stagehand cannot mutate the page because the resolver does not expose `stagehand_act`.

The resolver uses this decision order:

```text
structured page data and visible links
→ deterministic navigation
→ scoped model interpretation when evidence is ambiguous
→ deterministic final acceptance
```

The model interprets uncertain company, job, and page evidence. TypeScript controls URLs, progress, action limits, result formatting, and success.

### Persistent memory

Mastra stores agent threads and browser-context state through its official `LibSQLStore` adapter.

- Local development defaults to `file:./mastra.db`.
- Set `MASTRA_DATABASE_URL=file:/data/mastra.db` when deployment provides a durable volume.
- Set `MASTRA_DATABASE_URL` and `MASTRA_DATABASE_AUTH_TOKEN` for a remote LibSQL service.
- `mastra.db` is ignored by Git.

This storage preserves Mastra memory across process restarts. Ticket 6 still owns product run-state and result persistence.

Ticket 6 will move run execution and result storage into the deployed service so a run can continue after the frontend closes.

### Dynamic authenticated pages

Authenticated single-page applications can expose an empty shell at `domcontentloaded`, hydrate after the first DOM read, or keep background requests open indefinitely. The resolver waits for the evidence needed by the next step instead of waiting for global network idleness.

Use this observation order:

1. Read JSON-LD, hydration data, visible links, accessible names, and visible frame content.
2. Wait for a specific element, URL transition, or relevant response when required evidence is still loading.
3. Call the model only when deterministic evidence cannot select one supported result.
4. Refresh page state after navigation or mutation. Element references and cached observations do not survive arbitrary page changes.

Ticket 5 will measure phase time and model-call counts across 20 frozen cases. That evidence gates later optimization. Possible follow-up work includes evidence-aligned ATS readiness, scoped accessibility input, or replay of a stable observed action.

LinkedIn Voyager and similar authenticated endpoints are undocumented website behavior. They are not part of the current resolver. Adding one requires an explicit planning decision about breakage, compliance, and session risk.

References:

- [Playwright aria snapshots](https://playwright.dev/docs/aria-snapshots)
- [Playwright response waits](https://playwright.dev/docs/api/class-page#page-wait-for-response)
- [Stagehand determinism guidance](https://github.com/browserbase/skills/blob/HEAD/skills/browser-use-to-stagehand/references/determinism.md)

## MVP target

The MVP supports:

- LinkedIn → external job-source resolution;
- company careers fallback when needed;
- one Lever application path;
- one remote browser provider;
- one small deployed product surface.

The MVP does not include:

- Gmail ingestion;
- schedules;
- billing;
- generalized ATS plugins;
- multiple browser providers;
- microservices;
- workflow engines;
- large dashboards;
- production-scale multi-tenancy.

## Current implementation order

```text
Ticket 1 — Direct LinkedIn resolver (complete)
    ↓
Ticket 2 — Company careers fallback (complete)
    ↓
Ticket 3 — General application agent (active; review pending)

Ticket 1
    ↓
Ticket 5 — 20-job resolver evaluation (planned)

Tickets 2 + 3
    ↓
Ticket 4 — Connect resolver and auto-apply
    ↓
Ticket 6 — Server-side runs
    ↓
Ticket 7 — Final deployed product
```

See `plan.md` for ticket details and blockers.

## Verified resolver behavior

The final Ticket 2 verification used an authenticated local Chrome profile and OpenAI `gpt-5.6-luna`. Current evaluation runs use medium reasoning.

| Path | Result | Runtime |
|---|---|---:|
| Salesforce direct Apply | Resolved the matching Workday job | 45.4 s |
| Neuralink company fallback | Resolved `gh_jid=6083322003` | 49.7 s |

The Neuralink fallback previously took 109.7 seconds. Deterministic careers and exact-job selection reduced that path to 49.7 seconds. The authenticated LinkedIn page still requires model interpretation when it does not expose stable structured identity or a direct external URL.

`issues.md` contains the exact URLs, traces, screenshot paths, and remaining risks.

## Resolver output

The resolver takes a LinkedIn job URL and returns the matching external job destination.

Example:

```json
{
  "company": "Example Corp",
  "jobTitle": "Software Engineer Intern",
  "linkedinUrl": "...",
  "externalJobUrl": "...",
  "runtimeMs": 12345,
  "trace": [
    "Opened LinkedIn listing",
    "Identified company and job",
    "Followed external apply destination",
    "Validated destination"
  ]
}
```

## Career and application agents

The interactive product uses one conversational Mastra career agent with guarded resolution and application tools. The existing one-shot application command remains available for focused application proofs. AgentBrowser performs exact browser actions; Stagehand interprets uncertain page meaning only.

### Interactive terminal client

Start the interactive terminal client:

```bash
npm run apply:chat
```

The Pi-like client is only the input and transcript surface. Every ordinary message, including a greeting without a URL, goes to the same career-agent thread. The agent can discuss a role, open an exact user-supplied LinkedIn or ATS URL, resolve the external source, and apply. It chooses its next tool; the client does not run a URL or application wizard.

Assistant text streams as it is produced. Tool activity renders by safe tool name without arguments or results. One conversation can handle several jobs sequentially on the same runtime. Use `/status`, `/help`, or `/exit` for client lifecycle controls. `/cancel` ends the current career session and releases its browser resources.

When an application needs a missing private fact, `request_user_input` suspends the Mastra tool and sends a typed, value-free form request to the client. The exact response is saved as extensible session context and bound to the browser without being returned to the model. Generated free-form answers appear in chat and require approval. Guarded final validation produces a submission confirmation request; only an exact confirmation permits one final click.

Candidate facts, reusable answers, approved resume IDs, and declared credential handles are resolved in TypeScript. The agent receives only approved semantic keys. It can advance only an exact `Next` control. Unknown, Continue, review, and final controls block rather than risk navigation or submission.

During source resolution, the career agent can use general navigation and Stagehand interpretation against visible evidence. After `enter_application_mode` validates and locks an application form, raw snapshots, Stagehand, generic navigation, clicking, tab switching, typing, and selection are unavailable so filled private values cannot return to a model. Value-free inspection and protected tools own approved values, choices, credentials, uploads, exact Next, structured input, final validation, and the one confirmed submit attempt.

### Application commands

The application-agent path is verified without submission through a dedicated test command:

```text
npm run apply:test -- --url https://jobs.lever.co/ekimetrics/d9d64766-3d42-4ba9-94d4-f74cdaf20065/apply
```

Use the private factual profile and approved matching resume without authorizing submission:

```text
npm run apply:test:factual -- --url https://jobs.lever.co/ekimetrics/d9d64766-3d42-4ba9-94d4-f74cdaf20065/apply
```

Local Chrome fixtures verify protected fact/credential actions, conditional controls, exact Next, no-submit, and one controller click with same-page confirmation. An interactive local Lever run reached `ready_to_submit` without clicking submit; Browserbase application behavior remains unverified.

For an explicitly authorized real submission, complete the ignored `data/candidate/profile.json` with factual data that matches the approved resume, then run:

```text
npm run apply:submit -- --url https://jobs.lever.co/ekimetrics/d9d64766-3d42-4ba9-94d4-f74cdaf20065/apply
```

`submit` is false by default. With explicit `--submit`, TypeScript validates the current page and owns one final click; uncertain submission is never retried. The full suite and local no-submit Lever proof pass. No live application submission has been authorized or performed.

## Resolver evaluation

Project 2 requires testing against 20 randomly selected LinkedIn job URLs.

For each case record:

```text
LinkedIn URL
Company
Expected destination
Resolved destination
Success / Failure
Runtime
Notes
```

Primary metric:

```text
success rate = correct resolutions / 20
```

The expected destination should be labelled before running the resolver.

## Private inputs

Live runs require:

- `OPENAI_API_KEY` for the default model
- `GEMINI_API_KEY` only when `LLM_PROVIDER=gemini`
- `DEEPSEEK_API_KEY` only when `LLM_PROVIDER=deepseek`
- Browserbase credentials
- `MASTRA_DATABASE_URL` when the default local database path is not suitable
- `MASTRA_DATABASE_AUTH_TOKEN` only for authenticated remote LibSQL
- an authenticated Browserbase context when LinkedIn requires authentication
- a LinkedIn job URL
- candidate profile and resume when testing auto-apply

Keep secrets, real candidate data, resumes, and browser connection URLs outside Git.

## Agent workflow

The project uses three roles:

1. **Planning agent** — task scope and decomposition.
2. **Implementation agent** — behavior in `task.md`.
3. **Review agent** — correctness and acceptance evidence.

Only the behavior in `task.md` should be implemented.
Record signed work notes and findings in `issues.md`.

Read `AGENTS.md` before implementation or review.
