# Jobnova AI Engineer Take-Home — Project Brief

## Combined Product Architecture

Projects 2 and 3 can be built as one coherent **job-search and auto-apply agent** rather than as two disconnected demos.

### End-to-End Product Flow
```text
LinkedIn Job URL
    ↓
Job Source Resolver
    ↓
Company Careers / ATS Page
    ↓
Candidate Fit Check
    ↓
Application Agent
    ↓
Auto-fill + Resume Upload + Answer Generation
    ↓
Validation
    ↓
Submit
    ↓
Application Result + Audit Trail
```

### Product Components
```text
Job Agent
├── Job Source Resolver
│   ├── LinkedIn job page
│   ├── company website discovery
│   └── ATS / careers-page resolution
│
├── Candidate Profile
│   ├── resume
│   ├── personal information
│   ├── education
│   ├── work authorization
│   ├── preferences
│   └── reusable application answers
│
├── Match / Decision Layer
│   └── determine whether the job is a good enough fit to apply
│
├── Application Agent
│   ├── form understanding
│   ├── field mapping
│   ├── answer generation
│   ├── file upload
│   └── submission
│
└── Audit / Application Tracker
    ├── agent steps
    ├── decisions
    ├── errors
    └── application outcome
```

### Recommended Take-Home Scope
Keep the product broader in architecture but narrow in implementation.

For the demo, prove one complete path:

```text
LinkedIn URL
    ↓
resolve real job source
    ↓
open ATS application
    ↓
fill application from candidate profile
    ↓
submit
    ↓
record result
```

This demonstrates both **Project 2** and **Project 3** as parts of the same system while keeping the implementation manageable.


## Project 2 — LinkedIn Job Source Agent

### Objective
Build an agent that takes a LinkedIn job posting URL and returns the company's real external job source or careers page.

### Required Flow
1. Open the LinkedIn job listing.
2. Extract the company name and company website URL.
3. Navigate from the company website to its careers page.
4. Locate the company's actual job listing page or ATS page.
5. Return the final job-source URL.

### Example
**Input:** LinkedIn job posting URL  
**Output:** Company ATS/careers page such as Ashby, Greenhouse, Lever, Workday, or the company's own careers site.

### Requirements
- The solution should work across different company-site structures.
- Test against **20 randomly selected LinkedIn job URLs**.
- Report the success rate for correctly finding the company's job-listing page.
- Show the test results in the demo video.
- Provide a deployed website so the evaluator can test additional LinkedIn URLs.

### Suggested Architecture
```text
LinkedIn URL
    ↓
Browser Agent
    ↓
Extract company + external apply information
    ↓
Follow external ATS link if available
    ↓
Fallback: company website → careers page
    ↓
Validate destination
    ↓
Return job-source URL
```

### Useful Output
```json
{
  "company": "Example Corp",
  "linkedin_url": "...",
  "job_source_url": "...",
  "confidence": 0.96,
  "steps": [
    "Opened LinkedIn listing",
    "Identified company",
    "Visited company website",
    "Found careers page",
    "Validated ATS page"
  ]
}
```

### Success Metric
**Job-source resolution accuracy**

\[
\text{Success Rate} =
\frac{\text{Correctly resolved job-source pages}}{20}
\times 100
\]

---

## Project 3 — Job Auto-Apply Agent

### Objective
Build an agent that can autonomously complete and submit job applications on ATS-based websites.

The existing system uses Playwright with headless Chrome on EC2, but some ATS sites block submission through human-verification or browser-automation checks.

### Initial Target
Demonstrate the system on the provided **Lever** application.

### Required Flow
1. Open the job application page.
2. Identify application fields.
3. Map those fields to the candidate's stored profile.
4. Upload the resume and other required documents.
5. Generate answers for questions that require free-form responses.
6. Complete required application fields.
7. Validate the application before submission.
8. Submit the application.
9. Record the final result.

### Suggested Architecture
```text
Job URL
   ↓
Agentic Harness
   ↓
Persistent Browser Session
   ↓
ATS Form Detection
   ↓
Candidate Profile
   ↓
Field Mapping + Answer Generation
   ↓
Form Completion
   ↓
Validation
   ↓
Submit
   ↓
Application Result + Audit Trail
```

### Candidate Profile
Keep user information structured rather than repeatedly placing everything in the model prompt.

```text
CandidateProfile
├── personal information
├── education
├── employment history
├── work authorization
├── resume
├── skills
├── preferences
└── reusable application answers
```

### Browser Requirements
The browser layer should ideally support:
- persistent sessions
- cookies and authenticated state
- screenshots / vision
- DOM or accessibility-tree snapshots
- clicking, typing, scrolling, and file upload
- remote CDP/browser providers
- recovery from interrupted agent runs

### Agent Behavior
The agent should:
- use deterministic profile data whenever possible;
- generate an answer only when no stored answer exists;
- avoid inventing factual candidate information;
- validate required fields before submission;
- keep an audit trail of important decisions and actions.

### Minimal Human Involvement
The intended product behavior is autonomous application submission. Human involvement should be treated as an exceptional fallback rather than part of the normal workflow.

### Example Output
```json
{
  "job_url": "...",
  "company": "Example Corp",
  "status": "submitted",
  "application_id": "...",
  "fields_completed": 28,
  "generated_answers": 3,
  "errors": [],
  "steps": [
    "Loaded application",
    "Parsed form",
    "Uploaded resume",
    "Completed candidate information",
    "Generated written responses",
    "Validated required fields",
    "Submitted application"
  ]
}
```

### Success Metrics
Useful evaluation metrics include:
- application completion rate
- successful submission rate
- field-mapping accuracy
- number of manual interventions
- average application runtime
- rate of incorrect or fabricated candidate answers
