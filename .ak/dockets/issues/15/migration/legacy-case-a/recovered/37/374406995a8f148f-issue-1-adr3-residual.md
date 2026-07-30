# Issue #1 ADR 0003 status residual

Resolve the contradictory ADR 0003 status text in `docs/adr/0003-per-role-submission-tools.md`. At current head `e974c3c`, its canonical status is `accepted`, as frozen authority requires, but the retained supersession paragraph still says “The rest of this ADR remains under its existing `proposed` status.” Update that sentence to reflect that the ADR is accepted subject to ADR 0010’s explicit supersession; preserve the caller-owned commit-evidence and routing semantics.
