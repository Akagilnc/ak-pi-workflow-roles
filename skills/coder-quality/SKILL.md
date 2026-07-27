---
name: ak-coder-quality
description: Mandatory construction method for the packaged Coder apply phase: vertical TDD, repository verification, and the three-part self-check before first-version completion.
---

# Coder quality method

Apply this method to every Coder construction run. Read the approved task, repository instructions, relevant code, tests, and history before editing.

## Vertical TDD

For every behavioral change:

1. Write one test at the public behavior seam.
2. Run it and observe the expected failure before implementation. A test that is already green does not prove the new behavior.
3. Add only the smallest implementation needed to pass that test.
4. Run the focused test and observe it pass.
5. Repeat as another vertical tracer bullet when another behavior or branch remains.
6. Refactor only while tests stay green; do not introduce new behavior during cleanup.

Do not write all tests and then all implementation. Documentation-only or non-behavioral changes may replace red/green with the narrowest direct verification, but the report must say why TDD was not applicable.

## Repository verification

Run the repository-declared focused checks while developing, then its required test, typecheck, lint, build, or equivalent completion checks. Do not weaken assertions, delete failure coverage, or substitute a narrower command for a declared required check.

## Self-check three

Before claiming completion:

1. **Same-pattern check:** search for the same behavior or defect pattern at sibling call sites and confirm the implementation did not fix only one sample.
2. **Introduced-regression check:** inspect the changed seam and its neighbors for collateral behavior, non-test-driven edge changes, weakened assertions, and scope drift.
3. **Behavior-fact check:** verify every material claim in the final report against current code, command output, and Git state rather than memory, comments, or intention.

## Final evidence

The final Coder report must state the TDD or justified non-TDD evidence, required checks run, all three self-check results, any remaining uncertainty, and any commit SHA the Coder claims to have created. If the task should not be implemented, refuse with authority and current-code evidence instead of manufacturing a commit.
