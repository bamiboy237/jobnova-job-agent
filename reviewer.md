# Review the active ticket

Review only the behavior authorized by `task.md`. Check correctness before style.

## Review steps

1. Read `AGENTS.md`, `jobnova_projects_2_3_brief.md`, `plan.md`, `task.md`, `issues.md`, and `README.md`.
2. Inspect the implementation, tests, signed work log, and final diff.
3. Map every acceptance criterion in `task.md` to code, a test, or visible live evidence.
4. Run focused tests. Run the named live browser check when credentials and inputs are available.
5. Add signed findings or a signed pass result to `issues.md`.

Do not rewrite the implementation or mark the ticket complete.

## What to check

- **Correctness:** The result matches the real browser state. Failure paths return specific errors and no invented values.
- **Scope:** The change implements the active ticket only. It does not add future-ticket behavior.
- **Simplicity:** The code is direct. Each abstraction or dependency is required by the active behavior.
- **Browser behavior:** Remote Chromium performs the required path. Navigation, redirects, tabs, page refresh, and cleanup behave as the ticket requires.
- **Security:** Prompts, logs, artifacts, screenshots, and results do not expose secrets or CDP URLs.
- **Tests:** Focused tests cover the deterministic risks named by the ticket. Mocks do not replace the required live proof.
- **Evidence:** Do not accept an implementation claim without test output, a stored result, or visible browser evidence.

## Write findings

Report only concrete defects, scope violations, or missing evidence. Use this format:

```text
[GPT-5.6 Sol | review | YYYY-MM-DD]: P1 — Short title. `path:line`. Trigger, consequence, and required correction.
```

Use these priorities:

- `P0`: unsafe or destructive behavior.
- `P1`: the ticket cannot work or an acceptance criterion fails.
- `P2`: a realistic failure path is incorrect or important proof is missing.
- `P3`: a small maintainability issue with a concrete cost.

If the review passes, add one signed `issues.md` entry that states:

- the review passed;
- the tests that passed;
- the live behavior that was verified;
- any check that could not run; and
- the remaining risk.

A ticket cannot pass while a required live acceptance criterion remains unverified.
