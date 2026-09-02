# Project agent rules

## Product goal

Build one server-side job agent with two core capabilities:

1. Given a LinkedIn job URL, resolve the matching external job or ATS page.
2. Given a supported ATS application, complete and submit it using stored candidate data and an approved resume.

Build and verify those capabilities separately first, then connect them into one product.

Do not describe planned behavior as implemented behavior.

## Sources of truth

Read these before implementation or review:

- `jobnova_projects_2_3_brief.md` — take-home requirements and success criteria.
- `plan.md` — architecture, ticket backlog, blockers, and implementation order.
- `task.md` — the only active implementation task.
- `issues.md` — signed planning notes, implementation results, blockers, and review findings.
- `README.md` — product summary, setup, and evaluator-facing instructions.
- Code and tests — source of truth for implemented behavior.

If these conflict, follow the active `task.md` for implementation scope and record the conflict in `issues.md`.

## Engineering rule

Implement the smallest concrete solution that satisfies the active ticket.

Do not build infrastructure, abstractions, generalized interfaces, safety systems, or future-ticket behavior unless the current ticket requires them.

Prefer:

- direct code;
- explicit control flow;
- working browser behavior;
- narrow modules;
- observable results;
- focused tests.

Avoid:

- premature abstractions;
- provider registries;
- generalized ATS systems;
- workflow engines;
- unnecessary queues or worker layers;
- future-proofing for hypothetical requirements;
- large refactors unrelated to the active ticket.

If a second real implementation creates duplication or variation, refactor then.

## Ticket workflow

1. Work only on a ticket whose blockers are complete in `plan.md`.
2. Copy only that ticket into `task.md`.
3. Implement only the behavior in `task.md`.
4. Verify the acceptance criteria with focused tests or visible live behavior.
5. Record assumptions, blockers, checks, and unresolved risks in `issues.md`.
6. Review the implementation against `task.md`, `plan.md`, and this file.
7. Resolve review findings.
8. Mark the ticket complete in `plan.md` only after review passes.

`task.md` must contain exactly one task and no work log:

```markdown
- task:
- acceptance criteria:
```

Each ticket should deliver one narrow, demoable behavior.

Each acceptance criterion should describe an observable result.

Sign every added `issues.md` entry:

```text
[agent name | role | YYYY-MM-DD]: entry
```

## Agent roles

### Planning agent

Own:

- `plan.md`;
- task scope;
- blockers;
- architecture decisions;
- implementation order.

Protect the one-week scope.

Do not implement production code unless explicitly asked.

### Implementation agent

Implement only `task.md`.

Responsibilities:

- use direct code and explicit control flow;
- run relevant tests;
- verify acceptance criteria;
- avoid unrelated refactors;
- record ambiguity instead of silently making a major product decision;
- add signed implementation entries to `issues.md`.

### Review agent

Read `reviewer.md` before each review.

Review:

- correctness;
- scope;
- simplicity;
- tests;
- architecture alignment;
- requirement compliance.

Add concrete signed findings to `issues.md`.

Do not rewrite the implementation unless explicitly asked.

## Browser rules

Use Browserbase remote Chromium for the deployed product.

Use Stagehand where semantic or uncertain navigation helps, such as:

- understanding LinkedIn pages;
- extracting company and job identity;
- finding external apply links;
- navigating unfamiliar company or careers pages.

Use `agent-browser` where deterministic interaction matters, such as:

- form inspection;
- click/fill/select;
- resume upload;
- validation;
- submission;
- screenshots.

Do not let Stagehand and `agent-browser` control the same page at the same time.

Refresh page state after navigation or dynamic updates when needed.

Use DOM/accessibility information first. Use screenshots or vision when they materially help.

For dynamic authenticated pages:

- wait for the specific element, URL, response, or visible content required by the next assertion;
- do not use `networkidle` or an arbitrary sleep as proof that an application is ready;
- inspect structured data, hydration state, visible links, accessibility state, and visible frames before a model call;
- give the model only unresolved candidates and bounded evidence;
- refresh deterministic state after navigation or mutation before reusing a selector or element reference.

Treat undocumented authenticated endpoints as a planning decision. Do not add one silently as a deterministic shortcut.

Do not build a browser-provider abstraction unless a second provider is actually introduced.

## Model and data rules

Use Gemini 3.6 Flash with medium dynamic thinking as the primary runtime model. Keep OpenAI `gpt-5.6-luna` and DeepSeek V4 Flash Vision as explicit fallbacks selected through `LLM_PROVIDER`.

Use model reasoning for:

- uncertain navigation;
- page interpretation;
- field meaning;
- wording generated from known candidate facts.

Use deterministic code for:

- known validation rules;
- candidate facts;
- resume lookup;
- result formatting;
- submission control;
- metrics.

Do not invent candidate facts.

Provide candidate facts to the model only when needed for the active task.

Do not expose raw passwords, API keys, or CDP connection URLs in prompts, logs, artifacts, or user-visible results.

Store real candidate data and resumes outside Git.

Resolve an approved resume identifier to an application-owned file when resume upload is required.

## Submission rules

For application tickets:

- submit only when the requested behavior includes submission;
- validate required fields before submission;
- do not invent missing factual answers;
- if required information is missing, return a clear blocker;
- do not automatically repeat an uncertain submission action.

Do not implement submission behavior in tickets that do not require it.

## Observability

Keep two concepts separate.

### Developer tracing

Use framework tracing where useful for:

- model calls;
- tool calls;
- latency;
- retries;
- errors.

### Product audit trail

Store or return a concise human-readable sequence of important actions, for example:

```text
Opened LinkedIn listing
Identified company and job
Followed external destination
Validated job page
```

Do not build a general logging framework unless a current ticket requires one.

Capture screenshots only where they help verify the active ticket or explain a failure.

## Testing

Test behavior that materially affects the active ticket.

Prefer:

- focused deterministic tests for pure logic;
- one real browser proof for browser-heavy behavior.

Do not create broad mocked test suites for infrastructure that does not yet exist.

Do not test hypothetical providers, ATS platforms, or future failure modes.

For each ticket, report:

- what was tested;
- what was verified live;
- what could not be verified;
- remaining known risk.

## Runtime and persistence

Do not implement persistence, background execution, frontend state, or recovery before the active ticket requires them.

When those tickets become active:

- run one deployed Node.js + Mastra service;
- use the minimum persistence needed for run state and results;
- keep the run independent of the user's open frontend;
- avoid Redis, separate worker services, or workflow engines unless the current implementation proves they are necessary.

Do not add SQLite tables or checkpoint systems before a ticket needs them.

## MVP limits

The MVP supports:

- LinkedIn → external job-source resolution;
- one strong Lever application path;
- one remote browser provider;
- one small deployed product surface.

The MVP excludes:

- Gmail ingestion;
- schedules;
- billing;
- generalized ATS plugins;
- multiple browser providers;
- microservices;
- workflow engines;
- supervisor-agent hierarchies;
- production-scale multi-tenancy;
- large dashboards;
- generalized job-fit infrastructure.

Add broader capability only when a later ticket explicitly requires it.

## Scope rule

`task.md` is the implementation boundary.

If something is useful but not required by the active ticket, do not build it yet.

Working product behavior takes priority over architectural preparation.

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/openai__codex/` - `openai/codex` at `rust-v0.151.0`; inspect agent turns, tool execution, context compaction, retries, and session state.
- `.slim/clonedeps/repos/NousResearch__hermes-agent/` - `NousResearch/hermes-agent` at `v2026.8.27`; inspect browser snapshots, CDP supervision, auth persistence, context compression, and stall handling.
