Behavior: In `docs/adr/0003-per-role-submission-tools.md`, replace only the supersession paragraph’s final sentence so ADR 0003 is consistently `accepted`, subject to ADR 0010’s explicit supersession. Leave intact the paragraph’s caller-owned advisory commit-evidence semantics and its rejection of mandatory Judge authorship/next-hop routing.

Owner: ADR 0003 owns its canonical status declaration; accepted ADR 0010 owns the explicit caller-composition/routing supersession. The correction must reconcile those authorities rather than alter either decision.

Red: At HEAD `e974c3c242a675f4e455815bd19bfc55adce2e9c`, the header says `Status: accepted`, while line 8 says the remainder retains `proposed`; a direct textual inspection/grep demonstrates the contradiction.

Green: The header remains `Status: accepted`; the final supersession sentence states that the rest of ADR 0003 remains accepted, subject to ADR 0010’s explicit supersession; no `proposed` status claim remains. Verify by reviewing the one-file diff and searching ADR 0003 for both status terms and the preserved `caller`, advisory evidence, Judge-authorship, and next-hop language.

Scope: One documentation-only sentence in `docs/adr/0003-per-role-submission-tools.md`. No runtime, schema, Soul, tests, other ADRs, or caller-owned semantics change. Apply should create one forward commit; plan phase made no changes.
