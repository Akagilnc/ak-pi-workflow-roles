# Architecture wave 2 — deepen canonical Skill binding

Baseline: `4509371219be8601c4f6e538b92885f946918515`
Branch: `feature/deepen-role-runtime`

Perform a behavior-preserving, replace-not-layer refactor that gives Coder's canonical Matt TDD binding the same native-expansion provenance guarantees as Reviewer and concentrates both bindings in one deep internal module.

## Frozen public contract

Do not change role names, CLI flags, output tools/schemas, Souls, phases/status meanings, active tool surfaces, audit/fatal behavior, package installation, external canonical Skill truth sources, or orchestration semantics.

Canonical sources remain external and exact:

- Coder: `~/.agents/skills/tdd/SKILL.md`
- Reviewer: `~/.agents/skills/code-review/SKILL.md`

Do not bundle, copy, paraphrase, or fall back from either Skill. `completed` Coder apply becomes stricter only in the already-intended way: it must prove Pi natively expanded the canonical complete TDD Skill, rather than accepting a copied transcript marker. Coder `plan` and evidence-bearing `refused` retain current behavior. Reviewer behavior and provenance strictness must remain unchanged.

Do not work on broader role-runtime decomposition, test-harness deepening, Reviewer ledger redesign, Reviewer CMR, routing, or orchestration.

## Deep module responsibility

Replace the Reviewer-specific binding implementation with one canonical Skill-binding module used by both Coder and Reviewer. It owns:

- resolving the configured canonical `~/.agents/skills/<name>/SKILL.md` path through `realpath`;
- reading and validating the complete Skill snapshot;
- retaining raw, body, canonical path, and base directory evidence;
- producing or supporting the first-input native `/skill:<name>` invocation without name collisions;
- structurally parsing the immediately following Pi-expanded prompt with `parseSkillBlock`;
- exact name, canonical location, Pi reference preamble, complete frontmatter-stripped body, and original request comparison;
- returning immutable/detached evidence suitable for a role completion gate or audit record;
- role-neutral diagnostics that still identify the Skill and canonical path.

Keep role policy outside:

- which phase/status requires evidence;
- Coder report requirements;
- Reviewer compliance-audit input;
- input/lifecycle registration;
- `ctx.abort`, process exit, tool registration, role selection, and receipt validation.

The module must be deep: a small role-facing interface hides canonical filesystem resolution and Pi expansion proof. Two real adapters/consumers justify the seam; do not create a generic Skill registry, discovery framework, fallback search, event bus, or package-owned Skill mechanism.

## Test-first evidence

Preserve/add characterization through the existing production interfaces:

1. Reviewer exact native expansion remains accepted and copied markers, partial bodies, alternate paths, wrong names, wrong request text, task/assistant prose, and later-message evidence remain rejected/fatal exactly as today.
2. Coder apply first normal input invokes `/skill:tdd` and captures the immediately following native expansion structurally.
3. Coder `completed` accepts only exact canonical name, real path, full stripped body, Pi reference preamble, and original request.
4. Coder `completed` rejects marker-only, copied, partial, wrong-path, same-name alternate, wrong-request, and later-message evidence before acceptance.
5. Coder plan never requires or invokes TDD.
6. Coder refused remains legal without completion evidence and without commit; preserve current first-input behavior unless a mechanical conflict is demonstrated.
7. Missing, unreadable, or empty required canonical Skill fails closed as infrastructure in print/JSON rather than becoming a receipt status.
8. Test fixtures own temporary HOME Skills; full suite remains hermetic under initially empty HOME.
9. Reviewer audit receives the same complete canonical raw Skill and structured evidence as before.
10. Judge/Fixer/Reviewer package lifecycle and Coder report/self-check requirements remain unchanged.
11. Tarball contains the shared binding runtime but no `SKILL.md` or copied canonical content.

Do not weaken existing tests. Add direct binding-module tests for defensive snapshots and structural proof, while real packaged Pi lifecycle tests prove actual expansion.

## Unified verification gate

Run:

```bash
npm run typecheck
EMPTY_HOME=$(mktemp -d)
HOME="$EMPTY_HOME" npm test
npm pack --dry-run
git diff --check
```

Confirm the expected tarball files, no `SKILL.md`, strict ancestry from baseline, one Coder forward commit before review, and a clean worktree. Do not amend, squash, push, or begin wave 3. If facts make the seam unsafe, refuse with evidence.
