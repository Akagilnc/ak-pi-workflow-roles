# Construction-readiness plan — Issue #3 on c721b94

**Baseline:** `c721b94` (`feature/judge-artifact-relative-postures`, clean tree)  
**Phase:** plan only — no edits, no commits  
**Binding triage:** artifact-relative postures; no CLI posture flag; no persistent history; no routing/next-role; preserve verdict schema + ADR 0010/0011

---

## Carrier decision (Soul layering)

| Concern | Deepest rightful carrier | Why |
| --- | --- | --- |
| Authority / Plan / Apply / Review **burden-of-proof** | **`souls/judge.md`** | Irreducible professional judgment. Without it Judge cannot tell plan readiness from apply proof. Passes Soul admission: not schema-enforceable, not host-only. |
| Artifact-relative **`converged` meaning** (plan = construction authorization only) | **`souls/judge.md`** | Changes the judgment kernel currently hard-coded as apply-depth (“修复已在新 head 上通过必要验证”). |
| Plan five facts; blocking vs non-blocking law; complete-first / late-finding; authority freeze | **`souls/judge.md`** (short principles) | Judgment method. Keep lists tight; no fixture pseudocode. |
| Optional `note` as apply-obligation carrier | **Existing schema + Soul one-liner** | Schema already has advisory `note` (`src/judge-role.ts`). Soul only states plan may place construction obligations in `note` without new verdict state. |
| Caller-facing meaning of plan-`converged` / postures | **`README.md` (Judge + Verdict)** | Transport/usage docs. Short. No long rubric clone. |
| Optional vocabulary term “审理姿态 / posture” | **`CONTEXT.md` one line only if needed** | Term only; zero mechanism. |
| Mechanical invariants (singleton, schema shapes, tool narrowing, fatal audit) | **Unchanged runtime** | No posture field, no history store, no classifier. |
| Who invokes Judge / what runs next | **Outside package (ADR 0010)** | Do not touch. |
| Provider-specific review observations | **Outside (ADR 0011)** | Do not touch. |

**Decision summary:** small combination with **Soul as primary**. Posture is **not** a caller CLI distinction and **not** a runtime enum. Caller supplies materials; Judge infers burden from those materials alone.

**Out of scope (do not absorb):**
- Issue/ADR live bilateral contract **tracer**
- ADR 0008 destructive **seatbelt** / bash literal gates
- Orchestration, workflow DSL, retry caps, next-role fields, Judge phase flags

---

## Knife edge (real defect)

Current `souls/judge.md` defines a single apply-depth `converged`:

> 当前证据证明适用问题均已得到明确处置，修复已在新 head 上通过必要验证…

So plan judgment absorbs apply proof obligations (exact fakes, helper calls, calibration fields). That is the unhealthy loop. Fix the burden-of-proof law in Soul; leave receipt machine untouched.

---

## Acceptance clusters — Behavior / Owner / Red / Green / Scope

### A. Artifact-relative postures (no routing)

| | |
| --- | --- |
| **Behavior** | From supplied materials alone, Judge applies one of four burdens: authority completeness, plan construction-readiness, apply executable proof, review finding adjudication. No package routing semantics. |
| **Owner** | `souls/judge.md` |
| **Red** | Soul/runtime/README imply one universal apply-depth bar, or introduce posture CLI flag / call-history / next-role. |
| **Green** | Soul states inference-from-materials; no new flags/fields; README does not document a posture switch. |
| **Scope** | No topology, retry ceiling, or orchestrator ownership. |

### B. Plan readiness five facts + construction-ready `converged`

| | |
| --- | --- |
| **Behavior** | Plan needs Behavior / Owner / Red / Green / Scope covering governing authority. Plan `converged` = safe enough to construct — **not** that implementation evidence already exists. |
| **Owner** | `souls/judge.md` (`converged` rewrite); thin README note |
| **Red** | Plan `converged` still requires head verification / completed proof; or five facts absent from Soul. |
| **Green** | Soul defines five facts + construction-authorization `converged`; existing `converged \| continue \| escalate` enum unchanged in `src/judge-role.ts`. |
| **Scope** | No new verdict status; no worker-soul changes. |

### C. Plan blocking law + apply obligations in `note`

| | |
| --- | --- |
| **Behavior** | Block plans only for construction-readiness blockers (unresolved public behavior/owner, missing requirement, unclear seam, incompatible alternatives, absent red/green oracle, parallel mechanism / forbidden expansion, infeasibility, pre-construction security/irreversible choice). Implementation-local detail (exact names, fake arrays, full call syntax, table vs separate tests, which legal field calibrates a byte boundary, local algorithm inside approved seam) → apply obligations in existing optional `note`, not another plan rewrite. |
| **Owner** | `souls/judge.md`; `note` already in schema/runtime |
| **Red** | Soul treats fixture mechanics as plan blockers; or adds a new verdict/state for obligations. |
| **Green** | Soul draws the blocker / non-blocker line; allows `converged` + `note` for apply obligations; runtime still accepts that shape (already true). |
| **Scope** | No mechanical prose classifier in TypeScript. |

### D. Complete-first, late-finding, authority freeze

| | |
| --- | --- |
| **Behavior** | First non-converged plan verdict enumerates all readiness blockers discoverable from **this invocation’s** authority, plan, and current code. Later plan judgment re-checks those; new plan blockers only if revision introduces contradiction or new evidence shows infeasibility / contract-owner change. Newly noticed fixture detail → apply obligation, not goalpost move. Once authority accepted: no silent public-requirement expansion via plan review; real contract change named as authority-level issue. |
| **Owner** | `souls/judge.md` only (uses supplied evidence/history in current call — no package memory) |
| **Red** | Numeric retry cap; or Soul requires cross-invocation Judge state. |
| **Green** | Principles present without ceilings or persistent history. |
| **Scope** | Caller-owned repetition (ADR 0010) untouched. |

### E. Apply stays strict; Review stays adjudicative

| | |
| --- | --- |
| **Behavior** | Apply posture still demands real red/green exercise, real production/Pi/package seams, real time/byte/state boundaries, no duplicate guard / parallel mechanism / test-only production hook, plan obligations implemented, commit/diff/lifecycle claims match live facts. Review posture sustains/rejects findings against authority+code; does not demand Reviewer repair or turn review into routing. |
| **Owner** | `souls/judge.md` (reframe today’s universal “亲审测试质量” so it is apply-burden, not plan-burden) |
| **Red** | Apply bar weakened; or plan bar still forces apply-depth inspection before construction. |
| **Green** | Apply strictness retained and scoped; review independence retained. |
| **Scope** | No Reviewer/Collector soul edits. |

### F. Unchanged package contracts

| | |
| --- | --- |
| **Behavior** | `converged \| continue \| escalate` (+ optional `note`); singleton `ak_judge_output`; Soul-compliance audit; tool narrowing to read/grep/find/ls/bash/output; infrastructure → fatal non-zero; caller independence. |
| **Owner** | `src/judge-role.ts`, `src/soul-auditor.ts`, existing role tests — **expect no behavioral code change** |
| **Red** | Schema/tool/flag/audit surface drifts. |
| **Green** | `npm test` + `npm run typecheck` green; existing judge-role / package-entrypoint / audit-failure assertions still hold. |
| **Scope** | No Judge CLI phase flags. |

### G. Soul hygiene + delete phrase-grep + real role probes

| | |
| --- | --- |
| **Behavior** | Necessary judgment present; process/schema/CLI/fixture-pseudocode absent. Replace phrase-grep soul tests. Probes show both directions: unresolved contract/seam/oracle **blocks**; fixture-mechanics-only **does not** block (obligations in `note`). |
| **Owner** | `souls/judge.md`; `test/judge-soul.test.ts` (replace); new probe fixtures + test (below); light README |
| **Red** | Old Chinese fragment fishing remains sole soul gate; or only one direction covered; or live-tracer/seatbelt sneaks in. |
| **Green** | Principle-level presence/absence tests (reviewer/collector style); offline role probes through real Judge path with real bundled soul bytes. |
| **Scope** | No live paid-model CI dependency; no destructive seatbelt; no distribution tracer. |

---

## Proposed Soul shape (apply-time drafting guide; keep short)

Rewrite `souls/judge.md` as a tight kernel (~same length or shorter), roughly:

1. **Identity** — adjudicate only; no code/commit.  
2. **Evidence** — claims ≠ evidence; only current-head materials are current fact.  
3. **Postures (new)** — infer authority / plan / apply / review burden from materials; not flags/history/topology.  
4. **Plan readiness (new)** — five facts; construction-ready when they cover authority and no readiness blocker remains; `converged` on a plan authorizes construction only.  
5. **Plan blocking law (new)** — readiness blockers vs implementation-local apply obligations via `note`.  
6. **Complete-first / late-finding / authority freeze (new)** — no numeric ceiling; current-invocation evidence only.  
7. **Apply proof (reframed)** — keep strict test/seam/boundary/surface audit here.  
8. **Review adjudication** — sustain/reject findings; no repair/routing demands.  
9. **Repair principles** — delete/simplify > parallel guards; three questions (keep).  
10. **Verdicts** — three statuses with **artifact-relative** meanings; optional advisory `note` (no routing).  
11. **Infrastructure** — not a verdict; fail closed.  
12. **Stuck / owner gates** — escalate; no fixed round brake.

**Delete/compress from current Soul:** apply-only wording inside the universal `converged` definition; any implication that every judgment requires “新 head 验证” before converge.

**Do not put in Soul:** exact fake arrays, helper names, CLI, schema field catalogs, workflow examples, issue numbers, retry counts, orchestration.

---

## File-level construction slice (minimal)

| Path | Action |
| --- | --- |
| `souls/judge.md` | Rewrite kernel per above |
| `README.md` | Short Judge/Verdict note: postures inferred from materials; plan `converged` = construction authorization; `note` may carry apply obligations; no new flags |
| `CONTEXT.md` | Optional one-line posture term; skip if README+Soul suffice |
| `test/judge-soul.test.ts` | **Delete phrase-grep cluster**; replace with principle presence + pollution absence (mirror `reviewer-soul` / `collector-soul`) |
| `test/fixtures/judge-postures/*` + `test/judge-posture-probes.test.ts` (names flexible) | Recorded material bundles + offline in-process Judge probes |
| `src/judge-role.ts` / schema / flags | **No change** unless a test reveals accidental coupling (unexpected) |
| Worker/Reviewer/Collector souls, ADR 0008 seatbelt, tracers | **No change** |

### Probe design (both directions, offline, real role path)

Reuse `withInProcessPi` + `fauxProvider` pattern from `test/package-entrypoint.integration.test.ts` (not a new harness family).

**Fixture P-block (must not construct):** authority + plan missing Owner and/or Red/Green oracle (or contradictory seams). Scripted Judge emits `continue` with fix naming the readiness blocker. Assert: real soul injected; receipt `continue`; audit may pass on compliance; no new fields.

**Fixture P-ready (may construct):** issue’s B/O/R/G/S example (cross-leg contamination style is fine as generic prose). Plan omits exact IDs/fake arrays. Scripted Judge emits `converged` + `note` listing apply obligations (fixture precision, boundary calibration). Assert: accepted; `note` present; status not blocked for mechanics-only gaps.

**Fixture A-strict (apply still hard):** completed-work materials that claim green without real-seam/boundary evidence. Scripted Judge emits `continue` (or refuses converge). Assert apply-depth rejection still expressible.

**Fixture R-adjudicate:** Reviewer receipt findings; Judge sustains/rejects on facts without repair/routing orders.

Probes prove **package accepts posture-correct receipts under the new Soul** and **documents the two plan directions**; they do **not** add a TS classifier that grades free prose, and do **not** require live external models in CI.

Soul tests assert law text covers: posture inference, five facts, plan-converged meaning, blocker vs apply-obligation split, complete-first/late-finding, authority freeze, apply strictness, review independence; and excludes: `--ak-judge`, next-role, retry cap, workflow DSL, fixture pseudocode, Ming/host institutions (keep useful absences from old test without phrase-fishing the whole kernel).

---

## Verification plan

1. `npm test` — full suite green.  
2. `npm run typecheck`  
3. Targeted: `node --import tsx --test test/judge-soul.test.ts test/judge-posture-probes.test.ts test/judge-role.test.ts test/package-entrypoint.integration.test.ts test/audit-failure-subprocess.test.ts`  
4. Manual Soul admission pass (CLAUDE.md five questions) recorded in apply report.  
5. Diff audit: no new CLI flags; no schema leaf changes; no seatbelt/tracer files.

---

## Risks / non-goals

- **Soul bloat:** prefer compressed principles over copying the issue’s full bullet lists.  
- **Over-testing with scripted verdicts:** probes lock carrier + receipt shapes + both-direction fixtures; they do not pretend to score live model quality.  
- **Silent apply weakening:** keep apply strictness explicit when reframing test-quality language.  
- **Not doing:** orchestration, posture flags, history store, numeric ceilings, runtime objection classifier, issue #1 tracer, ADR 0008 seatbelt.

---

## Apply sequence (when authorized)

1. Rewrite `souls/judge.md` (kernel only).  
2. Replace `test/judge-soul.test.ts`.  
3. Add posture fixtures + offline probes (block vs ready; apply strict; review adjudicate).  
4. Thin README (and CONTEXT only if term needed).  
5. Run verification; fix only regressions at these seams.  
6. Stop — no amend/rewrite/push; report evidence in coder apply receipt.
