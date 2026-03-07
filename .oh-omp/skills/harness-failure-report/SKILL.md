---
name: harness-failure-report
description: Investigate and report an oh-omp dogfood failure. Prioritize diagnosis from within the harness first, then compare against an outside regular omp session only if needed. Produces a structured report focused on missing introspection, recoverability, and next fixes.
---

# Harness Failure Reporting

Use this skill when oh-omp behaves incorrectly during dogfooding and we need a consistent failure report.

Treat the appended `User:` line as the short failure summary.

## Objective

Determine how far the agent can get **from within the harness** before needing outside help, then capture the exact observability gap.

The goal is not only to fix the immediate problem. The goal is to answer:

1. Could the harness see the failure?
2. Could the harness explain the failure?
3. Could the harness recover from the failure?
4. If not, what exact introspection or tooling was missing?

## Required Stance

- Default to in-harness diagnosis first.
- Use tools and observed evidence, not guesses.
- Distinguish clearly between:
  - in-harness evidence
  - outside-harness evidence
  - hypotheses
- Only step outside the harness if the in-harness path stalls, remains ambiguous, or lacks required introspection.
- If you step outside, explain why that escape hatch was necessary.

## Procedure

### 1. Capture the failure context

State briefly:
- task underway
- observed failure
- expected behavior
- whether this looks like:
  - missing context
  - wrong context selection
  - bridge omission
  - freshness/invalidation issue
  - retrieval/hydration failure
  - model/provider issue
  - unrelated product bug

### 2. Investigate from within the harness first

Use the tools available in the current session to gather evidence.

Prefer:
- current config and mode
- relevant code paths
- relevant traces, logs, artifacts, or generated files
- recent tool outputs and touched paths
- reproducible prompts or commands

Do not step outside yet unless blocked.

### 3. Attempt in-harness recovery

If there is a low-risk recovery path, try it.
Examples:
- explicitly re-read the relevant file or symbol
- re-run the failing check with narrower scope
- inspect a trace/artifact directly
- correct a bad assumption and continue

Record whether recovery succeeded.

### 4. Escalate outside the harness only if necessary

If the harness cannot explain or recover, use a regular omp session or other out-of-band check to compare.

When you do this, capture precisely:
- what outside method you used
- what it revealed
- why that evidence was unavailable or insufficient inside the harness

### 5. Produce the report

Use this exact structure:

## Harness Failure Report

**Failure:** [one sentence]
**Task:** [one sentence]
**Expected:** [one sentence]
**Actual:** [one sentence]

### In-Harness Investigation
- Evidence gathered:
  - [...]
- Diagnosis:
  - [...]
- Recovery attempted:
  - [...]
- Recovery result: [Succeeded / Failed / Partial / Not attempted]

### Outside-Harness Comparison
- Needed: [Yes / No]
- If yes, method:
  - [...]
- What outside inspection revealed:
  - [...]
- Delta vs in-harness visibility:
  - [...]

### Observability Gap
- Missing introspection:
  - [...]
- Missing tool capability:
  - [...]
- Missing persisted artifact or trace:
  - [...]

### Classification
- Harness visibility: [Opaque / Legible / Recoverable / Self-healing]
- Root cause class: [missing context / wrong selection / bridge omission / freshness / retrieval / model / unrelated bug / other]
- Cutover impact: [Blocker / Serious / Moderate / Minor]

### Next Fix
- Immediate fix:
  - [...]
- Harness improvement:
  - [...]
- Follow-up experiment:
  - [...]

## Decision Rule

Interpret classifications this way:
- **Opaque**: harness could not meaningfully expose why it failed
- **Legible**: harness exposed enough state to explain the failure
- **Recoverable**: harness exposed enough state to continue with a reasonable next step
- **Self-healing**: harness usually recovered without stepping outside

Treat any escape to outside-harness debugging as a candidate observability bug unless strong evidence shows the failure was unrelated to the harness.

## Notes

- Keep the report concise but specific.
- Prefer exact commands, files, traces, and symptoms over narrative.
- If the user asks to preserve the report, write it to a file after presenting it in chat.
