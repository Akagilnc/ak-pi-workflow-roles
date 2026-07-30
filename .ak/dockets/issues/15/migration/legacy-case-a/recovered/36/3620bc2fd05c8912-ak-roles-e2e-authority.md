# Roles package E2E authority

Review target: the complete package snapshot at the pinned target HEAD.

Authority order: the owner's latest decisions in this file override older proposed ADR text when they conflict; otherwise committed README, CONTEXT, and ADRs are product authority.

## Core requirements

1. This is an independently installable Pi roles package, not an orchestrator. Roles are selected by `--ak-role`; currently judge and fixer.
2. Judge loads the complete bundled judge Soul, adjudicates ordinary Markdown review material without requiring a new upstream finding format, and submits only through `ak_judge_output`.
3. Judge acceptance requires a fresh separate active-model Soul-compliance call. Audit `revise` blocks; `pass` accepts. Temporary provider/toolchain failure is a non-zero Action failure.
4. Judge traffic is exactly: `converged`; `continue` with nonblank `fix.summary`; `escalate` with a nonblank decision gate. Workflow routing is out of scope.

## Latest owner-ratified Fixer contract

5. Fixer consumes the Judge-authored `fix.summary` as a Markdown file via `--ak-fix-packet`.
6. Fixer has exactly two explicit invocation phases via `--ak-fixer-phase`: `plan` means inspect and propose a repair plan without edits/commit; `apply` means execute an approved plan, verify, and commit when repaired. There is no third phase.
7. Callers discover the flag, its complete value set, and each value's meaning from `pi --ak-role fixer --help`; README also documents both.
8. Fixer submits one thin envelope through `ak_fixer_output`: `{ status: "planned" | "completed" | "refused", report: nonblank Markdown, commitSha?: nonblank string }`.
9. plan permits `planned|refused`; apply permits `completed|refused`. `planned` cannot carry commitSha. completed/refused use the same report key; partial repair plus dispute is refused and may include commitSha.
10. commitSha is advisory testimony so Judge can investigate concurrent directory changes. The package must not hard-block on mismatch with live HEAD.
11. Fixer does not emit escalate; requests for an owner decision go in a refused report, and Judge alone decides whether to escalate.
12. A real apply repair should create a forward commit without amend/rewrite. Git is objective evidence distinct from the Fixer receipt.

## Other committed proposed decisions to assess unless contradicted above

13. Soul uses generic package law with per-invocation host overlay rather than embedding business-specific law.
14. Per the latest owner-ratified ADR 0004 reversal at commit 622094b, targetHead binding is deferred until a real caller exists; do not build a dead binding gate now.
15. Judge role mechanically narrows active tools to evidence-gathering tools and removes write/edit. This is role gating, not a security boundary.
16. No automatic retry/brake for Soul-audit revision loops in this package.
17. Minimal engineering face includes CI for tests and typecheck as documented in committed ADR 0009.
