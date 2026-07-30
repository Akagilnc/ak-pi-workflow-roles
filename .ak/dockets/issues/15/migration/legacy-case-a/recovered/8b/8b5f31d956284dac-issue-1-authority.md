# Issue #1 frozen authority

## Authority audit — issue #1 only

### Evidence baseline
- Audited clean default head `34aa6fcde5bfe5000c3a1735e9cc4c29ae55c164`; `origin/HEAD` points to `origin/feature/judge-role`, and the worktree remained clean.
- Independently inspected `README.md`, `CONTEXT.md`, `package.json`, ADRs 0001–0011, all bundled Souls, Judge/Fixer runtime and audit seams, package-entry integration tests, and the newly landed issue #3 posture law/recordings.
- Mechanical baseline is green: `npm run typecheck` and `npm test` pass at this head (259 tests).

## Disposition of the original requirements

### Complete on current head; do not rebuild
1. `--ak-role judge` activation, bundled Soul injection, unsupported-role loud failure, package entrypoint/install documentation.
2. Named terminating Judge receipt, exact three-state schema, sole-final-tool-call enforcement, and plain-text non-receipts.
3. Fresh same-active-model Soul audit, named revise violations, audit-before-acceptance, and infrastructure failure outside verdict states.
4. Judge tool narrowing to registered `read`, `grep`, `find`, `ls`, `bash`, and `ak_judge_output`; `write`, `edit`, and sibling tools are excluded.
5. Fixer `plan`/`apply`, `planned|completed|refused`, advisory commit evidence, and README receipt contracts.
6. The generic Judge law. `souls/judge.md` is self-contained and host-neutral; issue #3 has since landed the four artifact-relative burdens. Issue #1 has no authority to rewrite, shorten, or otherwise reopen that law.
7. The real-model Judge liveness seam is now owned by issue #3’s checked-in true-`pi`/true-model posture recordings and documented operator re-record procedure; exact Soul delivery to both Judge and auditor is separately covered by the real Pi SDK/faux-provider package integration seam. Do not add a second generic live harness, model matrix, retry layer, CI paid-model gate, or `AK_*` wrapper merely to reproduce this chain. The recording provenance is not asserted as Apply proof for arbitrary future heads; issue #3’s re-record rule remains controlling when its Judge law changes.

All twelve original user stories are therefore implemented. Later roles do not enlarge issue #1.

### Deferred
- `targetHead` receipt/schema/env binding remains deliberately deferred by ADR 0004 and `CONTEXT.md`. The title’s “targetHead 绑定” phrase is stale and loses to the explicit same-day owner reversal in the body and ADR. Do not add a field, env input, equality gate, framework, or caller assert. The Soul’s requirement to inspect current-head evidence remains in force and is not mechanical binding.
- Cross-model audit, package-built retry/brakes, npm publication/LICENSE, and orchestration remain deferred/out of scope.

### Obsolete or superseded
- ADR 0010 supersedes every implication that Fixer packets or commit evidence must come from or return to Judge. A blocked Fixer may rewrite the command or submit an evidenced `refused` receipt to its caller; no `escalate` status or next-role route is added.
- “One hot session/no subtickets,” global test-count accounting against the 2026-07-27 stream, and phase-2 caller topology are process history, not package authority.
- The pre-issue-#3 instruction to delete the old Judge prose-grep test does not authorize deleting current `test/judge-soul.test.ts`: that file was replaced by issue #3’s accepted law checks and posture oracles. Issue #1 must not weaken or refactor those tests. No new phrase-grep Soul test is authorized for the residual below.
- ADR 0011 is accepted but irrelevant to issue #1; no Collector protocol work follows from this audit.

### ADR status promise resolved
- The promise to make 0001–0009 “uniformly accepted” is internally contradictory because ADR 0004 is expressly deferred. This authority review closes the proposal gate only for ADRs **0001–0003 and 0005–0009**; their status lines may be changed to `accepted` as documentation cleanup.
- ADR 0004 stays `deferred`; ADRs 0010/0011 stay `accepted`.
- ADR 0001’s fixed `judge + fixer` roster sentence is an obsolete historical snapshot and must be marked or removed while preserving only its demand-driven principle. Accepting ADR 0002 does not authorize its future orchestration phase. ADR 0003 remains subject to its explicit ADR 0010 supersession.

## Frozen minimal authority for remaining construction

The only production behavior still authorized is ADR 0008’s **Fixer seatbelt**:

1. **Owner/seam:** the package’s Fixer role controller (`createFixerRoleRuntime` / `src/worker-role.ts`) owns it as role gating. Register it only for an activated Fixer, in both phases. It is not a generic bash policy, caller policy, Soul clause, or cross-role mechanism.
2. **Input and exact law:** on a Fixer `tool_call` for `bash`, inspect only the string `command`. Block when it case-sensitively contains any one of exactly four ASCII literals: `rm -rf`, `git reset --hard`, `git clean`, `git checkout --`.
3. **Literal means literal:** use no tokenization, shell parsing, regex family expansion, whitespace normalization, case folding, alias/path/env decoding, command classification, or inferred equivalents. Literal occurrences inside otherwise harmless text are also blocked; variants not containing the exact bytes are outside this seatbelt.
4. **Outcome:** return an ordinary blocked-tool reason naming the matched forbidden literal. Do not execute that bash call, abort the session, synthesize a verdict, add confirmation UI, or terminate Fixer. The model may use a different spelling/operation or return `refused` evidence to the caller.
5. **Security semantics:** this is accidental-destruction drift prevention only. It makes no hostile-code, shell-sandbox, filesystem-isolation, or bypass-resistance promise. Adversarial isolation remains the caller’s container/sandbox responsibility.
6. **Documentation:** clarify the exact Fixer-only list and non-security boundary in ADR 0008 and the README; keep it out of every Soul and receipt schema.
7. **Green oracle:** extend the existing packaged real-Pi Fixer integration scenario rather than adding a prose/unit gate. For each exact literal, submit a safe bash command containing it and prove Pi returns the block reason without bash execution; retain a harmless nonmatching control that reaches bash. Do not add a new paid-model/CI path or a new top-level test solely for this. Existing Judge, Coder, Reviewer, Collector, receipt, audit, and caller-owned topology behavior must remain unchanged.

This freezes an implementable authority. Local handler/helper layout and test-fixture mechanics are Apply decisions; broad command classification, issue #2 work, orchestration, and caller topology are not authorized.
