# Job application agent

A job agent that resolves a LinkedIn job URL to the matching external job page. The planned product also completes one supported Lever application.

## Status

The direct LinkedIn resolver and company-careers fallback are complete.

- Ticket 1 resolves a usable direct external Apply destination.
- Ticket 2 resolves through the company website when direct Apply is unavailable.
- Ticket 5, the required 20-job evaluation, is the active task.
- Browserbase remains the production browser. Local Chrome supports development verification while the Browserbase account returns a quota error.

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
- OpenAI `gpt-5.6-luna` with high reasoning
- Gemini 3.7 Flash as an explicit fallback
- Browserbase remote Chromium
- Stagehand
- `agent-browser`
- Zod
- Railway
- SQLite when persistence is introduced

## Browser architecture

Browserbase provides the remote Chromium session used by the deployed product.

```text
Mastra agent
    ↓
Stagehand / agent-browser
    ↓
Browserbase
    ↓
LinkedIn / company sites / Lever
```

Use Stagehand for uncertain navigation and page understanding.

Use `agent-browser` for precise browser actions such as form interaction, resume upload, validation, submission, and screenshots.

The resolver uses this decision order:

```text
structured page data and visible links
→ deterministic navigation
→ scoped model interpretation when evidence is ambiguous
→ deterministic final acceptance
```

The model interprets uncertain company, job, and page evidence. TypeScript controls URLs, progress, action limits, result formatting, and success.

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
Ticket 5 — 20-job resolver evaluation (active)

Ticket 1
    ↓
Ticket 3 — Lever auto-apply

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

The final Ticket 2 verification used an authenticated local Chrome profile and OpenAI `gpt-5.6-luna` with high reasoning.

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

## Lever application

The application flow uses:

- a structured candidate profile;
- an approved resume;
- the provided Lever application.

Target:

```text
https://jobs.lever.co/ekimetrics/d9d64766-3d42-4ba9-94d4-f74cdaf20065/apply
```

The agent should:

```text
open application
→ inspect fields
→ map candidate data
→ upload resume
→ complete required fields
→ validate
→ submit
→ verify result
```

If required factual candidate information is missing, the agent returns a blocker instead of inventing a value.

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
- Browserbase credentials
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
