# Issue #3: judge: separate plan readiness from apply verification depth

## Context

During Collector v1 construction, the role closure loop exposed a Judge-depth problem:

```text
Authority judgment
→ Coder/Fixer plan judgment
→ Coder/Fixer apply judgment
→ independent Reviewer judgment
```

The early rounds were healthy. Judge fixed public behavior, evidence law, time law, and module ownership; after construction, Judge found real counterexamples despite a green suite.

The loop then became unhealthy at the **plan** step. Judge repeatedly withheld construction authorization until the plan specified implementation-level fixture mechanics: exact fake return arrays, complete library calls, exact collision facades, and which legal field would provide one-byte granularity at 8/32 MiB boundaries. Those are legitimate apply-time proof obligations, but the plan's behavior, owner, red oracle, green oracle, and scope were already stable.

Cross-model variation amplified the problem: worker plans used `or`, `e.g.`, or placeholders, while Judge progressively demanded quasi-code before permitting code to be written. Multiple plan rewrites occurred without changing the repair contract or owning seam.

This belongs to the roles package because it concerns the professional judgment exercised by Judge over Coder/Fixer receipts. Who invokes the roles, in what topology, and what happens next remain outside this package.

## Problem

Judge currently has no explicit burden-of-proof distinction between:

- whether an authority is complete enough to govern work;
- whether a proposed plan is safe enough to begin construction;
- whether completed construction has actually proved its claims;
- whether an independent review finding should be sustained.

As a result, `converged` can be interpreted as “all implementation details are already proven,” even when the artifact under judgment is only a plan. Plan judgment then absorbs apply judgment and produces low-value textual ping-pong.

The package must preserve one generic Judge role and the existing verdict contract. This issue must not add orchestration, routing, next-role semantics, retry ceilings, or a workflow DSL.

## Proposed judgment postures

These are burdens of proof applied to the material presented to Judge, not public workflow phases and not routing states.

### 1. Authority posture — contract completeness

Judge may be maximally strict about:

- public contracts and role boundaries;
- state, time, evidence, and trust semantics;
- irreversible decisions and owner choices;
- module ownership and external seams;
- contradictions or missing counterexamples that make later work unsafe.

Authority may remain unconverged until those matters are resolved.

### 2. Plan posture — construction readiness

For every planned change, Judge requires five facts:

1. **Behavior** — what observable requirement or defect is addressed?
2. **Owner** — which deep module/seam owns the behavior?
3. **Red oracle** — what counterexample must fail before repair?
4. **Green oracle** — what observable result proves repair?
5. **Scope** — what explicitly remains unchanged?

A plan is construction-ready once these cover the governing authority and no contract, owner decision, incompatible seam, or feasibility blocker remains unresolved.

`converged` in response to a plan means only: **the plan is safe enough to construct**. It does not testify that construction evidence already exists.

Judge may place concrete construction obligations in the existing optional `note`. The note remains advisory receipt content with no package-owned routing semantics.

### 3. Apply posture — executable proof

When judging completed work, Judge is strict about actual evidence:

- tests really exercised the claimed red/green behavior;
- fixtures crossed the required production/Pi/package seam;
- exact time/byte/state boundaries were actually reached;
- no duplicate guard, parallel mechanism, or test-only production hook was added;
- every governing counterexample and plan obligation is implemented;
- commit, diff, lifecycle, and verification claims match live facts.

Implementation-level fixture and calibration failures belong here.

### 4. Review posture — finding adjudication

When judging an independent Reviewer receipt, Judge decides whether each finding is factually sustained against current authority and code. It must not demand that Reviewer repair code or turn review prose into workflow routing semantics.

## Plan blocking law

Judge may keep a plan unconverged only for a construction-readiness blocker:

- unresolved public behavior or owner decision;
- missing governing requirement;
- unclear owning module/seam;
- mutually incompatible alternatives still open;
- absent red or green behavioral oracle;
- proposed parallel mechanism or forbidden scope expansion;
- evidence that the proposed construction is infeasible;
- security or irreversible choice that must precede construction.

Once behavior, owner, oracle, and scope are fixed, these are not plan blockers:

- exact helper/function/file names;
- exact fake arrays or fixture object literals;
- complete library call syntax;
- table-driven versus separate tests;
- which legal field calibrates an exact byte boundary;
- local algorithm choice inside the approved owning seam;
- implementation details that Apply judgment can decisively verify.

Those become apply obligations in `note`, not reasons to demand another prose rewrite.

## Complete-first and late-finding discipline

On its first non-converged plan verdict, Judge should enumerate all construction-readiness blockers discoverable from the supplied authority, plan, and current code.

On a later plan judgment, Judge checks those blockers. It may add a new plan blocker only when:

- the revision introduced a new contradiction; or
- genuinely new evidence proves the construction approach infeasible or changes a contract/owner decision.

A newly noticed fixture or implementation detail does not move the plan goalpost; it becomes an apply obligation.

This is not a numeric retry ceiling. A genuinely unresolved plan may iterate without limit.

## Authority freeze

Once Judge has accepted the governing authority:

- later plan judgment must not silently add public requirements;
- implementation risks default to apply obligations;
- a real contract change must be identified explicitly as an authority-level issue;
- fixture precision cannot mutate authority by attrition.

## Example

This is sufficient for construction readiness:

```text
Behavior:
Cross-leg request evidence contaminates a missing leg.

Owner:
Collector receipt's attempt-to-leg evidence join.

Red:
Two configured legs; only A has request/recovery evidence; B is missing.

Green:
B leg and B terminal report contain no A evidence IDs, while A evidence remains in the receipt root.

Scope:
Do not change request markers, terminal statuses, or the public receipt envelope.
```

Plan Judge may block if one of those facts is absent or contradictory. It should not block until the plan spells the exact IDs, fake arrays, or helper calls. Apply Judge must inspect whether the resulting test and implementation genuinely establish the oracle.

## Layering constraints

Follow the package's Soul discipline:

- only irreducible burden-of-proof judgment belongs in `souls/judge.md`;
- receipt fields and mechanical validity remain in schema/runtime;
- invocation examples belong in README;
- caller-specific process/topology belongs outside this package;
- do not add Judge CLI phase flags merely to encode a caller's workflow;
- do not duplicate a long review rubric across Soul, prompts, and docs.

The implementation should first decide whether the posture distinction is an irreducible Judge principle, a caller-supplied authority distinction, or a small combination. Soul must remain short.

## Acceptance criteria

- [ ] Judge can distinguish authority completeness, plan readiness, apply proof, and review adjudication from the material presented without new routing semantics.
- [ ] Plan readiness uses Behavior / Owner / Red / Green / Scope.
- [ ] Plan `converged` means construction authorization, not completed implementation proof.
- [ ] Plan blocking is limited to the construction-readiness law above.
- [ ] Implementation-local details can be carried as apply obligations in existing `note` without a new verdict state.
- [ ] Complete-first / late-finding discipline is defined without a numeric iteration ceiling.
- [ ] Authority freeze prevents later plan review from silently expanding requirements.
- [ ] Apply judgment remains strict and rejects implementations that fail exact real-seam or boundary evidence.
- [ ] Review finding adjudication remains independent from repair and routing.
- [ ] Existing `converged | continue | escalate` contract remains unchanged.
- [ ] Existing Judge singleton output, Soul-compliance audit, tool narrowing, fatal behavior, and caller independence remain unchanged.
- [ ] No orchestration, workflow DSL, next-role field, retry cap, generic finding classifier, or caller-specific topology is added.
- [ ] Soul review proves necessary judgment is present and implementation/process detail is absent.
- [ ] Tests or recorded role probes demonstrate both directions: unresolved contract/seam/oracle blocks, while fixture-mechanics-only objections do not block construction.

## Non-goals

- Weakening authority or apply review.
- Hiding genuine plan ambiguity.
- Limiting real design iteration by count.
- Having runtime classify prose objections mechanically.
- Encoding fixture pseudocode in Judge Soul.
- Specifying who invokes Judge or what role runs next.


## Binding triage interpretation at c721b94

- The issue is ready and remains artifact-relative.
- Construction authorization means the supplied plan meets construction-readiness burden; it does not direct a next role.
- Authority/Plan/Apply/Review posture must be inferred from supplied material, with no new CLI posture flag or persistent call history.
- Complete-first, late-finding, and authority-freeze rules may use only evidence/history supplied in the current invocation.
- Preserve ADR 0010 caller ownership and ADR 0011 separation between generic judgment and provider-specific observations.
- Keep existing verdict schema, singleton output, Soul audit, tool narrowing, fatal behavior, and caller independence.
