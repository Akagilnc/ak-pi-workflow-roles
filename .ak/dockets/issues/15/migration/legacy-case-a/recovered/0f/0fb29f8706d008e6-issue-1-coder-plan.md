Construction-readiness plan for clean HEAD `34aa6fcde5bfe5000c3a1735e9cc4c29ae55c164` (verified; no edits made):

## Behavior
- In `createFixerRoleRuntime` only, register a `tool_call` preflight when Fixer activates. For `bash` calls, inspect only `event.input.command` when it is a string.
- Compare with a fixed ordered list using case-sensitive literal substring matching only: `rm -rf`, `git reset --hard`, `git clean`, `git checkout --`.
- On the first matched literal, return Pi’s ordinary blocked-tool result with a reason that includes that exact literal. The bash tool must not execute. The session remains alive, no Fixer receipt is synthesized, and the model may try another operation or submit `refused`.
- Registration is phase-independent inside the Fixer controller, so both `plan` and `apply` receive the same seatbelt.

## Owner
- Production owner/seam: `src/worker-role.ts`, inside `createFixerRoleRuntime`’s existing one-time Fixer lifecycle registration. A tiny local constant/helper is acceptable only to keep the exact list and first-match behavior explicit; do not create generic bash policy infrastructure.
- Oracle owner: extend the existing `packaged fixer ...` scenario in `test/package-entrypoint.integration.test.ts`; do not add a top-level test file or prose/Soul gate.
- Documentation owners: Fixer section of `README.md`; `docs/adr/0008-role-gating-judge-toolset-narrowing.md`; status-only cleanup in ADRs 0001–0003 and 0005–0009, plus ADR 0001’s stale roster text.

## Red
- First modify the existing packaged real-Pi/faux-provider Fixer integration scenario to run Fixer through both `plan` and `apply`.
- In each phase, have the provider issue four safe `bash` tool calls, each command containing exactly one forbidden literal (for example after a shell comment) and otherwise attempting to write a unique execution marker. Assert each tool result is Pi’s ordinary blocked/error result, its text names the matched literal, and its marker file does not exist. This fails before implementation because bash executes and creates the markers.
- Retain/add a harmless nonmatching bash control that writes a separate marker; assert the successful tool result and marker contents. This guards against accidentally disabling Fixer bash wholesale.
- Preserve the scenario’s current assertions that Fixer keeps construction/sibling tools and enforces singleton `ak_fixer_output`; adapt fixture sequencing only as needed for the phase matrix.

## Green
- Implement the Fixer-local `tool_call` gate, then rerun the focused package-entrypoint integration test. Green means all 8 forbidden cases (four exact literals × two phases) name their literal and leave no marker, while both harmless controls reach real packaged Pi bash and create their markers.
- Run `npm run typecheck` and `npm test` for introduced regressions. Confirm existing Judge/Coder/Reviewer/Collector, receipt, audit, and caller-owned topology tests remain unchanged and green.
- Same-pattern check: use Pi’s established `tool_call` cancellation/block contract at the owning role lifecycle seam, while deliberately not sharing Reviewer/Collector policy machinery. Behavior-fact check is filesystem evidence (blocked markers absent, control marker present), not merely provider text.

## Documentation/status cleanup
- README Fixer section: state the exact four case-sensitive substring literals, both-phase Fixer-only scope, ordinary nonterminating block behavior, and that this is accidental-destruction drift prevention—not hostile-code defense, shell sandboxing, filesystem isolation, or bypass resistance; callers own container/sandbox isolation.
- ADR 0008: reconcile the amendment with the frozen law: exact four literals (not “一类”), Fixer-only/both phases, command-string literal matching, ordinary block/no execution/no termination, and the same non-security boundary. Remove/replace the optional confirmation implication because no confirmation UI is authorized. Keep Judge narrowing unchanged.
- Change only the status lines of ADRs 0001–0003 and 0005–0009 from `proposed` to `accepted`. Keep ADR 0004 `deferred`; keep 0010/0011 `accepted`.
- In ADR 0001, remove or mark obsolete `当前名册 = judge + fixer` while preserving the demand-driven admission principle. Do not use acceptance of ADR 0002 to implement its future orchestration phase; retain ADR 0003’s explicit ADR 0010 supersession.

## Scope/exclusions
- No Soul or receipt-schema changes; no `targetHead` field/env/equality gate; no Judge-law/test rewrite; no generic shell parser, regex expansion, whitespace/case normalization, tokenization, aliases/path/env decoding, inferred equivalents, confirmation UI, retries, model matrix, paid CI/live harness, orchestration, caller routing, publication/LICENSE, Collector work, or cross-role policy.
- Exact literal occurrences inside harmless text are intentionally blocked; variants lacking the exact bytes are intentionally outside this seatbelt. No security or bypass-resistance claim. No edits, amend/rewrite, push, or commit during this plan phase.
