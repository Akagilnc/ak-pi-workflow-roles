# Roles package authority v2

1. Deliver independently installable Pi roles selected by `--ak-role`.
2. Judge loads the complete bundled judge Soul and adjudicates according to it.
3. Before judge acceptance, a separate LLM call audits demonstrated Soul compliance; `revise` blocks, `pass` permits completion.
4. Judge output is exactly `converged`, `continue` with non-empty `fix.summary`, or `escalate` with a non-empty decision gate.
5. Roles must not require upstream workflows to adopt a new serialized report/finding format.
6. Judge traffic remains three-state. Temporary environment/toolchain failure is an Action failure; owner decisions use `escalate`.
7. Fixer consumes the judge-authored `fix.summary`, uses normal Pi tools to repair and test, and creates a new commit without amend/rewrite.
8. The caller owns mechanical Git validation: the new HEAD must be a strict forward descendant of prior HEAD. Fresh review then returns to judge.
9. Workflow routing and other roles remain out of scope for this slice.
