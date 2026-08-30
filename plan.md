# Implementation plan

## Outcome

Build and deploy one server-side agent product that:

1. accepts a LinkedIn job URL;
2. resolves the matching external job or ATS page;
3. can complete the provided Lever application using stored candidate data and an approved resume;
4. submits and verifies the application when instructed;
5. records a concise audit trail, screenshots, and final result; and
6. keeps running on the server after the user closes the frontend.

The take-home has two core capabilities:

```text
Project 2
LinkedIn URL
→ resolve external job source

Project 3
ATS URL
→ complete and submit application
```

Build and verify those capabilities separately first, then connect them into one product.

---

## Required deliverables

### Project 2 — Job source resolver

- A deployed resolver that accepts a LinkedIn job URL.
- A set of 20 randomly selected LinkedIn job URLs.
- Expected and resolved destinations for each case.
- A success/failure result and runtime for each case.
- The measured resolution success rate.
- A deployed URL the evaluator can test.

### Project 3 — Lever auto-apply

- A working application flow for the provided Ekimetrics Lever application.
- Structured candidate data and an approved resume.
- Form completion and resume upload.
- Required-field validation.
- Submission and visible result verification.
- A concise audit trail and screenshots.

### Product

- One deployed Node.js + Mastra service.
- A small page to start a run and view status/result.
- Server-side execution that continues after the frontend closes.
- Setup, usage, evaluation, and demo documentation.

---

## MVP boundary

The MVP supports:

- LinkedIn → external job-source resolution across different site layouts.
- One strong application path on Lever.
- One remote/cloud browser provider.
- One small deployed product surface.

The MVP does **not** include:

- Gmail ingestion;
- schedules;
- billing;
- a generalized ATS plugin system;
- multiple browser providers;
- microservices;
- a workflow engine;
- a supervisor-agent hierarchy;
- a large dashboard;
- production-scale multi-tenancy;
- generalized recommendation or job-fit infrastructure.

Job-fit scoring is optional and should only be added after the required resolver and auto-apply flows work.

---

## Architecture

### Stack

- TypeScript
- Mastra
- OpenAI `gpt-5.6-luna` with high reasoning
- Gemini 3.7 Flash as an explicit fallback
- Browserbase remote Chromium
- Stagehand
- `agent-browser`
- Zod
- SQLite when persistence is introduced
- Railway for the deployed service

### Browser roles

Use **Stagehand** where the page structure is uncertain:

- LinkedIn interpretation;
- company/job extraction;
- external apply discovery;
- company careers navigation;
- unfamiliar page validation.

Use **`agent-browser`** where precise interaction matters:

- form inspection;
- click/fill/select;
- resume upload;
- required-field checks;
- submission;
- screenshots.

Do not have Stagehand and `agent-browser` control the same page at the same time.

### Remote browser

Browserbase hosts the browser used by the deployed product.

The agent should operate on remote Chromium, not depend on the user's computer remaining open.

Use a persistent Browserbase context when authenticated state is needed. Keep Browserbase credentials and CDP connection URLs out of model prompts and user-visible output.

Do not build a provider registry. Browserbase is the only browser provider for this take-home.

### Agent logic

Inspect structured page data, visible links, frame URLs, and compact page state before calling a model. Use deterministic navigation when one candidate is unambiguous.

Use model reasoning for:

- interpreting unfamiliar pages;
- identifying company/job information;
- deciding how to navigate uncertain site structures;
- understanding application questions.

Use deterministic code for:

- URL validation;
- structured page signals and unambiguous link selection;
- readiness, progress, repeat-URL, and action-limit checks;
- bounded visible iframe evidence;
- candidate facts;
- resume lookup;
- required-field checks where practical;
- submission control;
- result formatting;
- metrics.

Prefer direct code first. Add abstractions only when the current implementation actually needs them.

### Dynamic page direction

For authenticated single-page applications, use this order:

1. Wait for the exact element, URL transition, response, or visible content needed by the next check.
2. Read structured data, hydration state, visible links, accessibility state, and visible frames.
3. Decide whether the evidence is sufficient with deterministic rules.
4. Give Stagehand only unresolved candidates and bounded evidence.
5. Refresh state after navigation or mutation before reusing an observation.

Do not use `networkidle` as a readiness condition. Polling and long-lived connections can prevent it from resolving, while server-rendered pages can reach it before hydration completes.

Ticket 5 must record coarse phase time and model-call counts. Use those measurements to decide whether another optimization ticket is justified.

Possible follow-up work is gated by the evaluation:

- If destination validation dominates, add evidence-aligned readiness and scoped accessibility evidence while preserving final Stagehand validation.
- If LinkedIn identity or Apply discovery dominates, make a separate planning decision before testing undocumented authenticated data endpoints or embedded application state.
- If one stable action repeats across cases, evaluate Stagehand observation replay. Do not add caching before repeated evidence shows value.

Do not add a crawler, a generalized network interceptor, or an endpoint registry for this work.

---

## Candidate data

For the Lever application, keep a small structured candidate profile containing only the fields needed by the application.

The profile may contain:

- personal/contact information;
- education;
- employment;
- work authorization;
- skills;
- reusable application answers;
- an approved resume identifier.

The agent must not invent missing factual candidate information.

If a required fact is missing, return a clear blocker rather than fabricating it.

The resume tool accepts an approved resume identifier. Application code resolves that identifier to the actual file.

---

## Results and audit trail

Every live run should return a small structured result and a concise ordered trace.

Example resolver result:

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

Example application trace:

```text
Opened Lever application
Mapped required fields
Uploaded resume
Completed form
Validated required fields
Submitted application
Verified result
```

Capture screenshots where they are useful for the demo or diagnosing a failed run.

Do not build a separate logging framework before it is needed.

---

## Evaluation

### Resolver

Test the completed resolver against 20 randomly selected LinkedIn job URLs.

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

### Auto-apply

For the Lever proof, record:

- whether the form was completed;
- whether the resume uploaded;
- whether required fields were satisfied;
- whether submission succeeded;
- whether the result was verified;
- runtime;
- failure reason, if any.

Keep the metrics useful to the take-home. Do not build an evaluation framework around them.

---

## Ticket rules

Each ticket should deliver one working, demoable capability.

Do not create separate tickets for implementation details such as:

- schemas;
- Browserbase setup;
- logging;
- screenshots;
- database tables;
- individual tools.

Those belong inside the product capability that requires them.

---

## Tickets

### Ticket 1 — Resolve a directly linked LinkedIn job

**Blocked by:** None.

**Status:** Complete.

**Delivers:** Given a LinkedIn job URL with a usable direct external destination, return the matching external job/ATS URL.

**Acceptance criteria:**

- Accept a LinkedIn job URL as input.
- Open one real LinkedIn listing through Browserbase remote Chromium.
- Extract the company and job title.
- Follow the direct external apply destination.
- Confirm the destination matches the company and job.
- Return:
  - company;
  - job title;
  - LinkedIn URL;
  - external job URL;
  - runtime;
  - concise ordered trace.
- Return a clear failure reason when resolution fails.
- Do not expose credentials or CDP URLs in output.
- Save one or two useful screenshots.
- One live run proves the complete path.
- Add only focused tests for deterministic logic that is worth testing.

**Out of scope:** company-site fallback, candidate data, resume upload, application forms, submission, persistence, frontend.

---

### Ticket 2 — Resolve through the company careers site

**Blocked by:** Ticket 1.

**Status:** Complete.

**Delivers:** When LinkedIn does not expose a usable direct job destination, navigate through the company site and return the matching job-specific careers/ATS page.

**Acceptance criteria:**

- Start from a LinkedIn job URL.
- Reuse the company/job identity extracted from LinkedIn.
- Navigate to the company website or careers site.
- Find a matching job-specific destination.
- Reject unrelated jobs and generic careers pages when a matching job page exists.
- Return the same result shape as Ticket 1.
- One live fallback example proves the complete path.

---

### Ticket 3 — Complete and submit the Lever application

**Blocked by:** Ticket 1.

**Delivers:** Given the provided Lever application URL, candidate profile, and approved resume, complete the application, submit it, and verify the result.

**Acceptance criteria:**

- Open the provided Lever application through Browserbase.
- Inspect the visible application fields.
- Map candidate data to the required fields.
- Upload the approved resume.
- Complete supported required fields.
- Stop with a clear blocker if required factual information is missing.
- Validate the form before submission.
- Submit when instructed.
- Verify the visible result after submission.
- Return a concise result, trace, runtime, and useful screenshots.
- One live run proves the Lever path.

**Out of scope:** generalized ATS support, ATS plugin systems, background execution, frontend.

---

### Ticket 4 — Connect resolution to auto-apply

**Blocked by:** Tickets 2 and 3.

**Delivers:** One agent run accepts a LinkedIn job URL, resolves the job source, and continues into the Lever application flow when instructed to apply.

**Acceptance criteria:**

- Start from a LinkedIn job URL.
- Resolve the correct external job destination.
- If the destination is the supported Lever flow and the user requests application, continue into Ticket 3.
- Preserve one concise audit trail across resolution and application.
- Return either:
  - resolved job information;
  - a clear blocker; or
  - a verified application result.
- One live end-to-end run proves the connected flow.

---

### Ticket 5 — Evaluate the resolver on 20 jobs

**Blocked by:** Ticket 2.

**Status:** Active.

**Delivers:** The required 20-case resolver evaluation and success-rate report.

**Acceptance criteria:**

- Select and freeze 20 LinkedIn job URLs.
- Label the expected destination for each before running the resolver.
- Run the resolver across all 20 cases.
- Record expected URL, resolved URL, outcome, runtime, and notes.
- Record coarse phase time and model-call count so latency can be attributed before optimization.
- Calculate the success rate.
- Group the main failure reasons.
- Produce a result that can be shown directly in the demo video.

Do not add a generalized evaluation framework.

---

### Ticket 6 — Run the product server-side

**Blocked by:** Ticket 4.

**Delivers:** A user can start a job-agent run, close the frontend, and later return to its stored status and result.

**Acceptance criteria:**

- Expose a small endpoint to create a run.
- Execute the run inside the deployed Node/Mastra service rather than the frontend request lifecycle.
- Persist the minimum run state needed to show progress and result.
- Persist the audit trail and screenshot references.
- A run continues after the user closes the frontend.
- A completed result can be retrieved later.
- Keep the implementation in one service. Do not add Redis, a separate worker service, or a workflow engine.

---

### Ticket 7 — Ship the evaluator-facing product

**Blocked by:** Tickets 5 and 6.

**Delivers:** The deployed take-home the evaluator can use and review.

**Acceptance criteria:**

- Deploy the Node/Mastra service.
- Provide a small page to:
  - enter a LinkedIn URL;
  - start the requested action;
  - view status;
  - view the audit trail and screenshots;
  - view the final result or blocker.
- Show the 20-case resolver results.
- Confirm the Lever flow works through the deployed product.
- Finish the README and demo instructions.
- Record the walkthrough video required by the take-home.

---

## Implementation order

Work the ticket frontier.

Primary sequence:

```text
Ticket 1 — Direct resolver
    ↓
Ticket 2 — Careers fallback
    ↓
Ticket 5 — Resolver evaluation

Ticket 1
    ↓
Ticket 3 — Lever auto-apply

Tickets 2 + 3
    ↓
Ticket 4 — Connect both capabilities
    ↓
Ticket 6 — Server-side product
    ↓
Ticket 7 — Final deployed experience
```

Ticket 5 can proceed once Ticket 2 is complete and does not need to block auto-apply work until the final product.

---

## Main risks

1. **Authenticated dynamic pages expose incomplete initial state.** Wait for observable page state, inspect deterministic signals first, and give the model only unresolved evidence.
2. **LinkedIn access fails in the remote browser.** Keep authenticated state in the configured browser context and return a specific authentication blocker.
3. **Model latency dominates ambiguous LinkedIn steps.** Measure model calls during Ticket 5 before adding another optimization ticket.
4. **Direct destination is absent or misleading.** Ticket 2 handles company-site fallback and exact-job validation.
5. **Stagehand and `agent-browser` interfere.** Use them sequentially.
6. **Lever fields differ from assumptions.** Inspect the real form and implement only what the live path requires.
7. **Required candidate information is missing.** Return a blocker rather than inventing it.
8. **The deployed run stops with the frontend.** Ticket 6 proves server-side execution explicitly.

---

## Architecture change rule

Do not add infrastructure because it might be useful later.

Add something only when a current ticket proves it is needed.

Examples:

- add an ATS-specific module when implementing a second ATS;
- add a browser-provider abstraction when implementing a second provider;
- add a workflow engine when plain run state cannot express a required behavior;
- add a separate worker/queue when one deployed service cannot reliably execute the required runs.
