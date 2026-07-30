# Issue #2: Institutional memory: judgment packets, development closure, probe lifecycle

Workshop learning currently lives in volatile places: the driver session (bounded, auto-compacts), `/tmp` probe files (lost on restart), and each fresh Judge (no memory — observed fresh instances paying an avoidable first-submission audit tax before relearning “evidence first”). Lessons must live where they are enforced, not where one session happens to remember them.

This issue owns **institutional-memory carriers for developing this roles package**. It does not define product orchestration, caller topology, stage transitions, or a workflow runtime.

The Judge plan-depth law is owned by #3. This issue consumes that law after #3 resolves its correct layer; it must not restate or independently mutate it.

## Tasks

- [ ] **1. Posture-aware judgment packet templates** (new `packets/` layer beside `souls/`, only if #3 confirms packet participation):
  - `judge-authority.md`
  - `judge-plan.md`
  - `judge-apply.md`
  - `judge-review.md`
  - `fixer-repair.md`

  Each template contains only an invariant dispatch skeleton: required artifact paths and digests, the relevant burden of proof, required evidence classes, and notice that Soul audit traces factual claims. It must not duplicate Soul text, implementation recipes, or caller routing.

  Evidence requirements vary by judgment posture:

  | Packet | Required evidence depth |
  |---|---|
  | `judge-authority` | authority clauses, decisions, counterexamples, artifact digest |
  | `judge-plan` | #3’s Behavior / Owner / Red / Green / Scope construction-readiness law; no implementation-fixture pseudocode |
  | `judge-apply` | live code/tests, `file:line` where applicable, real seam/probe evidence, committed artifact digest |
  | `judge-review` | each finding bound to authority, current code/facts, and reviewed-range digest |
  | `fixer-repair` | exact Judge-sustained repair scope and preserved non-goals; **mandated-item ledger (R#)** — see below |

  Guard-audit three-question evidence is required only when the judged change actually adds or approves a new guardrail.

  **Mandated-item ledger (`fixer-repair` only).** Evidence from the Collector repair line (2026-07-28): three consecutive post-fix rounds each caught approximate delivery — skipped matrix rows, similar-but-not-ordered cases substituted, one oracle omitted per row — and the Judge had to reconcile delivered-vs-ordered rows by hand each round. Mechanical reconciliation belongs at the receipt gate, not in a judgment seat:

  - the repair packet enumerates every mandated counterexample/row/oracle with a stable ID (`R1..Rn`); no mandated item may arrive only as prose;
  - the fixer receipt must carry a per-item disposition table: `R# → implemented(<test name>) | refused(<reason>)`;
  - the Soul audit rejects any receipt whose disposition table does not cover the packet's full `R#` set — approximate delivery bounces at submission, before any Judge round.

  This reuses the existing audit/receipt machinery; no new mechanism. (Same medicine that cured bare-`converged`: the cheapest path through the gate becomes literal compliance.) A blanket `file:line` requirement must not leak Apply burden into Authority/Plan judgment.

  Amendments are forward commits through the normal role-development closure. **Dependency:** do not finalize `judge-plan.md` before #3 determines whether the law belongs in Soul, packet, caller authority, or a small combination. **Acceptance:** a fresh Judge’s first evidence-complete submission passes Soul audit without requiring implementation detail before construction.

- [ ] **2. `docs/development-closure.md` contributor checklist** (not root `FLOW.md`): one-page description of how this repository’s maintainers close role construction. Include the canonical manual sequence, artifact preservation rules, and restart hygiene:
  - an accepted artifact is never discarded/redone without explicit disposition;
  - filenames must not claim verdicts (`approved` is a gate result, not a naming choice);
  - timeout guidance may vary by docket weight;
  - after restart/compaction, re-seed by reading the artifact trail before dispatching.

  The document must state explicitly that it is a contributor/dogfood playbook, is not packaged workflow authority, does not prescribe who calls a role, and creates no routing or next-role semantics.

- [ ] **3. Probe lifecycle law** (one concise paragraph in `CLAUDE.md`): probes are Judge drafts. After adjudication, each probe either graduates into a Fixer/Coder red regression test or dies; keeping both is duplicate shape. Sole exception: a bare-seam probe that exercises a seam ordinary tests cannot reach may graduate into `test/adjudication/` as a permanent regression. Do not retain volatile `/tmp` probes as institutional truth.

## Explicitly removed from this issue

`ak-flow` / stage machine / artifact-transition blocker / persisted flow-ledger work does not belong to `@ak/pi-workflow-roles`. The package remains caller- and topology-independent. If a real orchestrator or driver later demands that capability, it requires separate authority in the owning repository; this issue does not pre-create or defer-build it.

## Acceptance criteria

- [ ] #3 remains the single source for Plan Judge depth; this issue only consumes it.
- [ ] Packet names align with Authority / Plan / Apply / Review postures.
- [ ] Plan packets do not require Apply-level fixture or `file:line` proof.
- [ ] Apply/Review packets preserve exact evidence and digest sealing.
- [ ] `docs/development-closure.md` is clearly contributor-only and non-packaged as workflow authority.
- [ ] Probe lifecycle has one graduation path and no duplicate permanent shape.
- [ ] No stage machine, flow ledger, routing, next-role semantics, or workflow DSL enters this package.

Items 1–3 are file-only institutional-memory work. They should be implemented only after #3’s semantic decision is settled, so carrier and law do not drift apart.


