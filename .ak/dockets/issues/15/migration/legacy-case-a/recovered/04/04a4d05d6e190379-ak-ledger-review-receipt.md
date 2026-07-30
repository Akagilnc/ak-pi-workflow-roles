# Reviewer receipt

## Standards

Verified clean detached HEAD at `6bb1eb6`; reviewed only `380b205...6bb1eb6`.

1. **Hard — persisted Agent provenance does not own the audited prompt.** `beginAgentCall` captures persisted arguments, but then overwrites the attempt from independent `rawArguments` without comparing them (`src/reviewer-execution-ledger.ts:389-455`); that second value is dispatched (`src/role-runtime.ts:507-522`). Thus the audit can receive a prompt different from the persisted assistant call, undermining Reviewer traceability (`souls/reviewer.md:3-6`) and the runtime’s responsibility for mechanical invariants (`CLAUDE.md:13,17`). A scratch probe confirmed differing persisted/runtime prompts are accepted and the runtime prompt is audited.

2. **Hard — terminal attempts can be begun again.** At `src/reviewer-execution-ledger.ts:452-456`, `beginAgentCall` silently succeeds when an attempt is already `successful` or `failed`. The runtime consequently proceeds to invoke the child (`src/role-runtime.ts:506-527`), detecting the illegal transition only after potentially expensive work or workspace effects. This violates the runtime-owned state-combination discipline (`CLAUDE.md:13`). Scratch probe: `running → successful → beginAgentCall` was accepted.

3. **Hard — the ledger permits contradictory pinned targets.** `recordForAudit` selects the first available snapshot with `.find()` (`src/reviewer-execution-ledger.ts:611-620`) rather than requiring all attempts to match. The committed test even supplies different “first” and “later” snapshots. This can present one top-level target while child evidence concerns another, contrary to the fixed-target Soul (`souls/reviewer.md:5-6`) and README’s “one session-pinned target” contract (`README.md:126`).

4. **Judgement call — Primitive Obsession / shallow module.** The exported ledger exposes a ten-step string-ID choreography—`“beginAgentCall… completeAgentCall… failAgentCall… rejectAgentCall… recordBashCall…”` (`src/reviewer-execution-ledger.ts:68-88`). Runtime still coordinates legal ordering across Pi hooks (`src/role-runtime.ts:877-928`), producing findings 1–2; an owned attempt handle/state-machine boundary would be deeper.

After scratch-only `npm ci`, all 84 tests and typecheck passed. Soul layering remained clean; Judge/Fixer/Coder behavior and package lifecycle/export coverage were audited with no additional findings.

## Spec

Verified pinned target `6bb1eb6` and exact range.

### Missing/partial requirement

1. **Ledger remains Pi-coupled.** Controlling spec: “Define one stateful factory with no getters or Pi imports.” `src/reviewer-execution-ledger.ts:1,15-30` imports and exposes Pi’s `Usage` type. Even though type-only, the supposedly internal policy module depends on Pi’s SDK contract rather than owning a host-neutral evidence shape, weakening the required deep boundary.

### Scope creep

None found.

### Implemented incorrectly

2. **Conflicting runtime/persisted arguments are accepted as valid provenance.** Controlling spec: `beginAgentCall` “reconciles an identical repeated Pi start/execute observation idempotently” and owns “uniqueness/conflict rules.” `src/reviewer-execution-ledger.ts:389-455` compares persisted batches only; it creates/overwrites the current attempt from `rawArguments` without checking those arguments against the persisted call or a prior observation. Counterexample: persisted prompt `"A"`, first or repeated runtime prompt `"B"`; completion succeeds and audit records `"B"` despite persisted evidence `"A"`. This permits non-identical observations to silently rewrite provenance instead of failing atomically.

3. **Infrastructure failures do not preserve the original thrown value.** Controlling spec: “`recordInfrastructureFailure` records Skill/audit/cleanup fatal diagnostics while preserving the original thrown failure for the host fatal adapter.” `src/reviewer-execution-ledger.ts:522-525` converts every non-`Error` rejection into `new Error(String(error))`; host paths then throw that replacement at `src/role-runtime.ts:595-610,931-937`. A provider/cleanup rejecting a sentinel object or string therefore loses identity, type, and structured evidence, whereas baseline rethrew the original value.

After scratch-only `npm ci`, typecheck and all 84 tests passed; dry-run tarball had 14 files and no `SKILL.md`; diff-check passed. Scratch probes reproduced both counterexamples above.

Summary: Standards — 4 findings; worst: audited Agent provenance can diverge from persisted provenance. Spec — 3 findings; worst: conflicting Agent observations silently rewrite provenance.
