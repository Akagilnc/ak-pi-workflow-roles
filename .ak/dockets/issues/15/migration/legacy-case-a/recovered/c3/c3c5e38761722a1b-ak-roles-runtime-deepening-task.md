# Architecture wave 3 — deepen role implementation locality

Baseline: `05413b2e14b956e079eeb0bc20a1595fb562b3f6`
Branch: `feature/deepen-role-runtime`

Perform a behavior-preserving, replace-not-layer refactor that removes four-role implementation knowledge from the 1,035-line `src/role-runtime.ts` monolith while keeping one stable package-facing extension factory.

## Frozen public contract

Do not change role names, flags/help, output tool names/schemas, exported receipt/audit types, Souls, phases/status meanings, tool surfaces/order, Skill behavior, Reviewer Agent/ledger behavior, audit/fatal/revise semantics, usage/termination, package installation, or caller-visible diagnostics relied on by tests.

Do not introduce generic role discovery, role configuration files, a common submission tool, routing/orchestration, CMR, model selection, target binding, retries, or test-harness deepening. Preserve ADR 0001 demand-driven roles and ADR 0003 named role submission tools.

## Desired depth and locality

Keep `createRoleRuntimeExtension(dependencies)` as the single external module interface and `extensions/role-runtime.ts` as the package adapter. The host should own only process-wide/Pi-wide composition concerns:

- registering shared CLI flags;
- validating/selecting the active role;
- dispatching activation to the selected internal role implementation;
- any truly shared Pi fatal-action adapter that cannot belong to one role;
- stable re-exports required by current source consumers.

Move coherent implementations behind internal seams:

1. **Judge module** owns Judge schema/validation, named submission tool, singleton final-call behavior, Soul audit policy invocation, exact tool narrowing, and Judge prompt contribution.
2. **Worker module** owns the proven common Coder/Fixer mechanical implementation: worker output validation, plan/apply legality, singleton output, and thin receipt construction. Coder and Fixer remain explicit named adapters with their own flags, task loaders, Souls, prompt guidance, tool names, and Coder-only canonical TDD completion policy. Do not erase their domain distinctions into a generic role table.
3. **Reviewer module** owns Reviewer activation, named Agent/output tools, canonical code-review binding policy, Reviewer execution-ledger adaptation, bash evidence hooks, compliance audit, child shutdown, exact tool narrowing, and Reviewer prompt contribution. The existing ledger and canonical binding remain separate deep modules, not copied into it.

Prefer modules with small role-host interfaces that hide role-specific state and lifecycle. Avoid shallow one-function files that merely forward every dependency/flag/event unchanged, and avoid a wide shared context object exposing the entire runtime. The deletion test should show that deleting a role module would force its complexity back into the host, not merely delete a pass-through.

Do not force all roles through identical lifecycle operations when their behavior differs. Shared helpers are justified only by at least two real consumers and must own meaningful invariant complexity.

## Test-first evidence

Before movement, preserve/add characterization through production interfaces for:

- exact flag registration/help for all four roles;
- no-role inert behavior and unsupported-role failure;
- exact Soul/task/packet prompt bytes;
- exact tool registration and active-tool sets;
- named singleton terminating tools and all schema combinations;
- Coder plan/apply/TDD strict provenance/refusal behavior;
- Fixer plan/apply behavior;
- Judge three verdicts, note, audit revise/fatal, and narrowing;
- Reviewer Skill/Agent/ledger/audit/fatal/shutdown/event-order behavior;
- print/JSON non-zero infrastructure failures;
- package lifecycle and tarball contents.

Add focused tests through each role module's public internal interface only where they increase locality; retain real extension/package tests as the authoritative integration surface. Do not weaken or delete assertions to make modules fit.

Require a structural audit after implementation:

- `src/role-runtime.ts` is a composition host rather than a hidden second implementation;
- no role state machine remains duplicated in the host;
- no role module is a shallow pass-through;
- no generic role framework or common submission tool exists;
- current exported names remain source-compatible via explicit re-exports;
- Souls and public docs are unchanged unless a stale internal file reference must be corrected without semantic change.

## Unified verification gate

Run:

```bash
npm run typecheck
EMPTY_HOME=$(mktemp -d)
HOME="$EMPTY_HOME" npm test
npm pack --dry-run
git diff --check
```

Confirm expected tarball files/no `SKILL.md`, strict ancestry, one Coder forward commit before review, and a clean worktree. Do not amend, squash, push, change test architecture, or begin wave 4. Refuse with evidence if a proposed seam would only create shallow modules.
