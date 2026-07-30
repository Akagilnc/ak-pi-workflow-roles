# Architecture wave 1 — deepen the Reviewer execution ledger

Baseline: `380b20515a821d6200625d5cb22cead2b699c25e`
Branch: `feature/deepen-role-runtime`

Perform a behavior-preserving, replace-not-layer refactor that moves Reviewer execution evidence/state/completion invariants out of the 1,216-line `src/role-runtime.ts` closure into one deep internal module.

## Frozen public contract

Do not change:

- role names or CLI flags;
- output tool names or schemas;
- Soul content or professional meaning;
- Coder/Fixer `plan|apply` semantics;
- Reviewer `completed|refused` semantics;
- canonical Skill locations or invocation behavior;
- tool surfaces;
- audit `pass|revise`, fatal infrastructure behavior, usage, or termination;
- package installation or tarball contents except for replacing internal source files.

Do not work on canonical Skill unification, broader role-runtime decomposition, test-harness deepening, CMR, routing, or orchestration in this wave.

## Deep module responsibility

Create one coherent Reviewer execution-ledger module. It owns the Reviewer evidence state and its invariants:

- canonical Skill expansion evidence once supplied by the runtime host;
- persisted sibling Agent invocation batches and uniqueness/conflict rules;
- exactly one attempt lifecycle per persisted Agent call ID;
- running/successful/failed settlement and diagnostics;
- target snapshot and workspace disposition evidence;
- parent bash command/result evidence;
- infrastructure-failure state as evidence;
- proof that `completed` has a non-empty exact one-to-one persisted-call/attempt match with every attempt settled successful;
- construction of a copied/immutable `ReviewerExecutionRecord` for compliance audit.

The ledger does **not** own Pi side effects:

- no `ctx.abort()`;
- no `process.exitCode`;
- no tool registration;
- no role selection;
- no system-prompt construction;
- no provider calls;
- no audit dispatch.

The role runtime host remains the adapter for Pi lifecycle events and owns fatal action handling. It should translate Pi events/persisted messages into the ledger through the smallest practical interface, and translate ledger failures into the existing fatal channel. Do not create a generic event bus, role framework, repository, or speculative interface.

The resulting module must be deep: callers/tests learn a small interface while batch reconciliation, state transitions, exact completion proof, defensive copying, and diagnostic construction stay inside. Do not merely move the existing arrays and helper functions unchanged behind a wide bag-of-getters.

## Test-first evidence

Before moving implementation, preserve or add characterization for the current behavior at the existing public/runtime interface, including:

1. same assistant message produces one shared parallel batch;
2. separate assistant messages produce separate batches;
3. duplicate IDs and conflicting batch evidence fail before child start;
4. schema-invalid persisted sibling is recorded failed even though Pi validation prevents `Agent.execute`;
5. completed is rejected before audit for missing, extra, running, failed, duplicate, or non-settled attempts;
6. successful Agent results preserve report, usage, target snapshot, and workspace disposition;
7. bash evidence pairs calls/results correctly;
8. audit input is a defensive immutable copy and cannot mutate ledger state;
9. refused remains auditable without Skill/Agent completion evidence;
10. infrastructure errors still abort and exit non-zero in print/JSON through the host;
11. Judge, Fixer, Coder, Reviewer package lifecycle and all existing behavior remain unchanged.

Direct ledger tests should exercise its public interface, while real Pi lifecycle/package tests continue to exercise the same production seam. Do not weaken, delete, or rewrite existing behavior assertions merely to fit the extraction.

## Unified verification gate

Run:

```bash
npm run typecheck
EMPTY_HOME=$(mktemp -d)
HOME="$EMPTY_HOME" npm test
npm pack --dry-run
git diff --check
```

Confirm no `SKILL.md` is packaged and the worktree is clean after one forward commit. Do not amend, squash, or push. If the current implementation facts make this seam unsafe, return an evidence-bearing refusal rather than broadening scope.
