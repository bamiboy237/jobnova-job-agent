- task:
  Complete Ticket 5 only. Select and freeze 20 random LinkedIn job URLs, label each expected external destination before execution, run the completed resolver, and report the measured resolution success rate and failure groups. Use the existing resolver without building a generalized evaluation framework.

- acceptance criteria:
  - Record all 20 LinkedIn URLs and independently confirmed expected destinations before resolver execution.
  - Run each case through the existing resolver with the configured authenticated browser and model.
  - Record company, expected URL, resolved URL, success or failure, runtime, and concise notes for each case.
  - Record model-call count and coarse time for browser setup, LinkedIn inspection, company/careers navigation, and final validation. Use direct timestamps and the existing result; do not build a tracing system.
  - Calculate `correct resolutions / 20` and group concrete failure reasons.
  - Preserve the Ticket 1 and Ticket 2 resolver behavior. Fix only defects proven by the frozen evaluation cases.
  - Produce one evaluator-facing result that can be shown in the demo video.
  - Record tests, live checks, unresolved cases, and remaining risks in signed `issues.md` entries.
  - Do not add a crawler, ATS plugin system, broad web search, persistence, background execution, frontend state, or a generalized evaluation framework.
