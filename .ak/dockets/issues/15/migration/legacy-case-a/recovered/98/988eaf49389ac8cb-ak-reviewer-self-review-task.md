# Independent review task — Reviewer v0

Fixed point: `3808c2dca83417b5e07e4b8f922914435d01be7c`
Reviewed target: `d979a8779033966c84db9f511f29566acd2935f5`

Run the canonical three-dot review of current `HEAD` against the fixed point. The reviewed change is commits `98f36c0` and `d979a87`; `3808c2d` is the concurrent authority commit immediately before them and is outside this diff.

Spec authority, in order:

1. `/tmp/ak-roles-reviewer-v0-task.md`
2. `/tmp/ak-reviewer-plan-revision.md`
3. `/tmp/ak-reviewer-approved-plan-candidate.md`
4. Judge approval recorded in `/tmp/ak-reviewer-plan-judge-2.jsonl`
5. `/tmp/ak-reviewer-fix-packet.md`
6. `/tmp/ak-reviewer-fixer-plan-revision.md`
7. Final Judge construction instruction in `/tmp/ak-reviewer-fixer-plan-judge-2.jsonl`

Repository standards sources include `CLAUDE.md`, `CONTEXT.md`, applicable ADRs under `docs/adr/`, existing role patterns, public package behavior, and tests.

Review both Matt axes exactly as the canonical Skill requires. Pay particular attention to real counterexamples involving:

- active provider/auth propagation into in-process child agents;
- parallel Agent-call isolation and writable scratch clones;
- fixed-point ref preservation after remote removal;
- canonical Skill expansion provenance;
- completed/refused gates and infrastructure-fatal behavior;
- audit separation and faithful execution records;
- package installation outside the source checkout;
- regressions in Judge, Fixer, Coder, especially Coder's existing `/skill:tdd` behavior;
- Soul content discipline and accidental workflow-routing semantics.

The review may create fixtures/probes only inside each assigned isolated scratch clone. Do not repair, commit, push, or mutate the original target.
