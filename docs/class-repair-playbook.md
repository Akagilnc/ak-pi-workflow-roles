# Class-repair caller playbook

This is repository-specific caller practice. It does not change any role's single-invocation contract or give the roles workflow topology; callers remain owners of composition, repetition, budgets, and stopping under ADR 0010.

## Durable doctrine

The defining difference between Fixer and Coder is **class repair rather than point repair**:

- Coder completion is external: the ticket's acceptance set defines what is complete.
- Fixer completion is internal: a reported defect is evidence of a class hidden in the code, so Fixer must derive that class before claiming completion.
- A Reviewer finding is an instance and counterexample, not repair authority and not the class inventory.
- Reviewer discovers instances; Judge adjudicates the defect class, owner, authority boundary, and repair authorization; Fixer Apply removes the class; Reviewer checks for class residuals.
- Every Reviewer Must, Should, and Nit is adjudicated before repair. A later passing test, silent review, audit result, or repair receipt does not retroactively grant authority.
- The repair fence is the issue and governing authority, not the wording or file list in a repair packet. Same-class instances inside that fence are in scope; crossing it requires refusal and a new ruling.
- Keyed finding dispositions prove that every authorized finding was covered. They do not define the implementation shape or substitute for a class census.

## Fixer obligations

For every authorized class repair, Fixer must:

1. state the shared invariant and the owner where that invariant belongs;
2. search the whole authorized scope for all same-class instances rather than only cited lines;
3. repair the common construction point so the class cannot recur, instead of stacking point guards;
4. cover the class with a table, matrix, property test, or another whole-class oracle;
5. report the search boundary, census method, repaired instances, explicit exceptions, and verification evidence;
6. return `refused` when the class or authority boundary cannot be established safely, so the caller can obtain a new ruling.

## Default caller loop

```text
Reviewer instances + counterexamples
→ Judge class/owner/boundary adjudication
→ Fixer Apply (direct; no routine Fixer Plan)
→ Reviewer class-residual check when sustained Must/Should existed
```

When the adjudicated set contains only Nits, apply the authorized repair and proceed to gates/final judgment without an automatic extra review. Callers may stop or choose another topology; this playbook records this repository's normal repair road, not package routing law.

## Plan stations

The normal road has no Coder Plan or Fixer Plan station:

- a ticket carrying authority plus `Behavior / Owner / Red / Green / Scope` is the Coder plan and goes directly to Coder Apply;
- a Judge class disposition carrying invariant, owner, boundary, counterexamples, and verification burden is the Fixer plan and goes directly to Fixer Apply.

A caller adds a plan invocation only when it must produce a checkable artifact that does not already exist: a mechanical whole-work inventory or an unresolved boundary/interface decision. A plan that merely paraphrases the ticket or Judge ruling is skipped.

## Copyable bounded Reviewer task

```markdown
Review immutable range <base>...<target> under <sealed authority>.

Use exactly one sibling-parallel Standards/Spec batch. Findings are discovery evidence only. For each finding provide a concrete current-target counterexample and identify the suspected defect class/owner without authorizing repair. Review the complete authorized owner boundary for same-class residuals, not only previously cited lines.

Jurisdiction is limited to <issue/authority keys>. Record observations outside that fence for their owning issue; do not use them to block this construction. Do not rerun a verification battery already proved by admitted Coder/Fixer receipt and native invocation-session evidence; mechanically inspect that evidence and spend execution on judgment-oriented reading and bounded probes.

Submit only through ak_reviewer_output.
```

## Copyable class Judge request

```markdown
Adjudicate every Reviewer Must, Should, and Nit before repair against <sealed authority> and fixed target <sha>.

Treat cited lines as counterexamples, not a point checklist. Group duplicate instances into bounded defect classes. For each class return: finding dispositions; shared invariant; owning construction point; issue/authority fence; authorized whole-class search and repair burden; required class oracle; preserved non-goals. Dispositions are sustain | dismiss | superseded | insufficient-evidence (or an equivalently bounded ruling).

Do not authorize findings outside the issue/authority fence. If the class or fence is indeterminate, require refusal/escalation rather than guessed repair. Submit only through ak_judge_output.
```

## Copyable Fixer class-Apply dispatch

```markdown
Sole repair authority: <Judge receipt identity>.

Apply the sustained/narrowed defect classes directly; do not run a Fixer Plan. Reviewer locations are samples. For each class derive and report the invariant and owner, mechanically search the whole issue/authority fence, repair the common construction point, add a table/matrix/property oracle, and report census method, search boundary, repaired instances, exceptions, and verification. Return exactly one nonblank keyed disposition for every authorized finding as coverage proof, but organize implementation by class.

If the class or authority boundary cannot be established safely, return refused with evidence. Do not self-authorize adjacent classes. Commit forward and submit only through ak_fixer_output.
```

## Fresh-window acceptance

On the next new-window ticket, give the caller no oral class-repair instructions. Issue #25 remains open unless the caller discovers this playbook through the repository pointer and uses the same bounded Reviewer → class Judge → direct Fixer Apply method without reverting to point patches or paraphrasing plan stations.
