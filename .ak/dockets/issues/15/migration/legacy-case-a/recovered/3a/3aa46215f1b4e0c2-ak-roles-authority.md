# Judge role v0 authority

Owner requirements from the design conversation:

1. Deliver the judge first as an independently installable Pi package.
2. Invocation selects it with `--ak-role judge`.
3. The role must load the complete bundled judge Soul and adjudicate according to that Soul.
4. Before final acceptance, a separate LLM call determines whether the judge demonstrably followed the Soul; `revise` blocks and `pass` allows completion.
5. Final output is fixed to `converged`, `continue` with non-empty `fix.summary`, or `escalate` with a decision gate.
6. The role must not require an upstream workflow to adopt a new report/finding format.
7. Workflow orchestration and other roles are out of scope for this slice.
8. Judge traffic remains three-state. Temporary environment/toolchain failure is an Action failure; owner decisions use `escalate`.
