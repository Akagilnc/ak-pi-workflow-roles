# Construction-readiness plan (revised) — Issue #3 on c721b94

**Baseline:** `c721b94` (`feature/judge-artifact-relative-postures`, clean tree)  
**Phase:** plan only — no edits, no commits  
**Incorporates:** `/tmp/issue-3-plan-corrections.md` (Judge `continue` on prior plan)  
**Binding triage:** artifact-relative postures; no CLI posture flag; no persistent history; no routing/next-role; preserve verdict schema + ADR 0010/0011

---

## Corrections absorbed (why this rewrite)

Prior plan failed construction readiness on two points. This plan closes both:

1. **Cluster G oracle is real role-law evidence, not scripted transport.**  
   Do **not** use `fauxProvider`-told `continue`/`converged` as proof that posture law works. That only proves receipt plumbing (already covered by `test/package-entrypoint.integration.test.ts` / `test/judge-role.test.ts`).  
   **Required proof:** two checked-in recorded artifacts from **actual packaged Judge executions** under the **revised bundled Soul** and **real Soul-compliance audit**, using only supplied materials and no posture flag / call history / topology. CI validates those artifacts offline; CI must not call a paid model.

2. **Authority posture gets its own full Behavior / Owner / Red / Green / Scope**, with a compact authority-burden law in Soul. Incomplete public contracts/boundaries, state·time·evidence·trust semantics, irreversible owner choices, seams, or contradictions **block authority**. Authority `converged` does **not** require Apply executable proof.

3. **Scope guard** explicitly excludes **issue #1** (live tracer / ADR 0008 seatbelt) **and all issue #2** (posture-aware judgment packet templates / institutional-memory envelope work beside `souls/`).

---

## Carrier decision (Soul layering)

| Concern | Deepest rightful carrier | Why |
| --- | --- | --- |
| Authority / Plan / Apply / Review **burden-of-proof** | **`souls/judge.md`** | Irreducible professional judgment. Not schema-enforceable; not host-only. Passes Soul admission. |
| Artifact-relative **`converged` meaning** | **`souls/judge.md`** | Kernel currently hard-codes apply-depth (“修复已在新 head 上通过必要验证”). Must become material-relative. |
| Authority completeness burden | **`souls/judge.md`** (compact principle) | Missing from current Soul and from prior plan outline. |
| Plan five facts; blocking vs non-blocking; complete-first / late-finding; authority freeze | **`souls/judge.md`** (short principles) | Judgment method. No fixture pseudocode. |
| Optional `note` as apply-obligation carrier | **Existing schema + Soul one-liner** | `note` already advisory in `src/judge-role.ts`. Soul only says plan may place construction obligations in `note` without a new verdict state. |
| Caller-facing posture / plan-`converged` meaning | **`README.md` (Judge + Verdict)** thin note | Usage docs only; no long rubric clone. |
| Optional vocabulary “审理姿态 / posture” | **`CONTEXT.md` one line only if needed** | Term only; zero mechanism. Skip if README+Soul suffice. |
| Mechanical invariants (singleton, schema, tool narrowing, fatal audit) | **Unchanged runtime** | No posture field, history store, or prose classifier. |
| Who invokes Judge / what runs next | **Outside package (ADR 0010)** | Untouched. |
| Provider-specific review observations | **Outside (ADR 0011)** | Untouched. |
| Role-law behavioral oracle (both plan directions) | **Checked-in recorded Judge artifacts + offline CI validators** | Real model under revised Soul + real audit once at apply-time; CI re-validates bytes, not re-calls paid models. |
| Receipt transport / schema / narrowing / fatal audit | **Existing faux/unit/integration tests** | Keep as transport coverage only; not role-law proof. |

**Decision summary:** small combination with **Soul as primary**. Posture is inferred from supplied materials alone — **not** a CLI distinction, **not** a runtime enum, **not** package memory.

---

## Knife edge (real defect)

Current `souls/judge.md` defines a single apply-depth `converged`:

> 当前证据证明适用问题均已得到明确处置，修复已在新 head 上通过必要验证…

Plan judgment therefore absorbs apply proof (exact fakes, helper calls, calibration fields). That is the unhealthy loop. Fix burden-of-proof law in Soul; leave the receipt machine untouched; prove both plan directions with **recorded real Judge executions**, not scripted fakes.

---

## Explicit non-goals / scope guard

**Do not absorb or start:**

- **Issue #1** — live CLI tracer; ADR 0008 destructive **seatbelt** / bash literal denylist; remaining general-law rewrite chores owned by #1.
- **Issue #2** — all Judge **packet/envelope** / institutional-memory work (`packets/` layer, `judge-authority.md` / `judge-plan.md` / `judge-apply.md` / `judge-review.md`, fixer repair packet templates, mandated-item ledgers). #2 consumes #3’s law after #3 lands; this slice must not create `packets/`, templates, or envelope carriers.
- Orchestration, workflow DSL, retry caps, next-role fields, Judge phase/posture CLI flags, persistent Judge history, runtime prose classifiers.
- Weakening authority or apply strictness.
- Encoding fixture pseudocode in Soul.
- Specifying who invokes Judge or what role runs next.

---

## Acceptance clusters — Behavior / Owner / Red / Green / Scope

### A. Authority posture — contract completeness (full oracle)

| | |
| --- | --- |
| **Behavior** | When supplied materials are governing authority (contracts, role boundaries, decisions), Judge applies **authority completeness** burden: incomplete or contradictory **public contracts / role boundaries**, **state·time·evidence·trust** semantics, **irreversible decisions / owner choices**, **module ownership / external seams**, or **contradictions / missing counterexamples that make later work unsafe** keep authority unconverged. Authority `converged` means the contract is complete enough to govern later work — **it does not require Apply executable proof** (no demand for red/green tests already run, real-seam fixtures, byte/time boundary calibration, commit/diff lifecycle proof). |
| **Owner** | `souls/judge.md` (compact authority-burden principle + material-relative posture inference) |
| **Red** | Soul has no authority-burden law; or treats authority like apply (demands implementation evidence to converge authority); or silently expands authority during later plan review; or introduces posture CLI / history. |
| **Green** | Soul states authority blockers above; authority `converged` ≠ apply proof; inference-from-materials only; no new flags/fields. Soul tests assert this presence. |
| **Scope** | No topology, packet templates (#2), or apply-depth inspection required for authority convergence. |

### B. Artifact-relative postures (no routing)

| | |
| --- | --- |
| **Behavior** | From supplied materials alone, Judge selects one burden: authority completeness, plan construction-readiness, apply executable proof, or review finding adjudication. Not public workflow phases; not routing states. |
| **Owner** | `souls/judge.md` |
| **Red** | One universal apply-depth bar; or posture CLI flag / call-history / next-role field. |
| **Green** | Soul states inference-from-materials; README does not document a posture switch; runtime enum unchanged. |
| **Scope** | No orchestrator ownership (ADR 0010). |

### C. Plan readiness five facts + construction-ready `converged`

| | |
| --- | --- |
| **Behavior** | Plan needs **Behavior / Owner / Red / Green / Scope** covering governing authority. Plan `converged` = **safe enough to construct** — not that implementation evidence already exists. |
| **Owner** | `souls/judge.md` (`converged` rewrite); thin README note |
| **Red** | Plan `converged` still requires head verification / completed proof; or five facts absent. |
| **Green** | Soul defines five facts + construction-authorization meaning; `converged \| continue \| escalate` enum unchanged in `src/judge-role.ts`. |
| **Scope** | No new verdict status; no worker-soul changes. |

### D. Plan blocking law + apply obligations in `note`

| | |
| --- | --- |
| **Behavior** | Block plans only for construction-readiness blockers: unresolved public behavior/owner; missing governing requirement; unclear owning module/seam; mutually incompatible alternatives; absent red/green behavioral oracle; proposed parallel mechanism / forbidden scope expansion; evidence construction is infeasible; security/irreversible choice that must precede construction.  
**Not plan blockers** once B/O/R/G/S fixed: exact helper/function/file names; exact fake arrays / fixture literals; complete library call syntax; table-driven vs separate tests; which legal field calibrates a byte boundary; local algorithm inside approved seam; other details Apply can decisively verify. Those become **apply obligations in existing optional `note`**, not another prose rewrite. |
| **Owner** | `souls/judge.md`; `note` already in schema/runtime |
| **Red** | Soul treats fixture mechanics as plan blockers; or adds a new verdict/state for obligations. |
| **Green** | Soul draws blocker / non-blocker line; allows `converged` + `note`; runtime still accepts that shape (already true at c721b94). |
| **Scope** | No mechanical prose classifier in TypeScript. |

### E. Complete-first, late-finding, authority freeze

| | |
| --- | --- |
| **Behavior** | First non-converged plan verdict enumerates all readiness blockers discoverable from **this invocation’s** authority, plan, and current code. Later plan judgment re-checks those; new plan blockers only if revision introduces contradiction or new evidence shows infeasibility / contract-owner change. Newly noticed fixture detail → apply obligation, not goalpost move. Once authority accepted: no silent public-requirement expansion via plan review; real contract change named as authority-level issue; fixture precision cannot mutate authority by attrition. Uses only evidence/history supplied in the current call — no package memory. |
| **Owner** | `souls/judge.md` only |
| **Red** | Numeric retry cap; or cross-invocation Judge state. |
| **Green** | Principles present without ceilings or persistent history. |
| **Scope** | Caller-owned repetition (ADR 0010) untouched. |

### F. Apply stays strict; Review stays adjudicative

| | |
| --- | --- |
| **Behavior** | **Apply:** real red/green exercise; real production/Pi/package seams; real time/byte/state boundaries; no duplicate guard / parallel mechanism / test-only production hook; plan obligations implemented; commit/diff/lifecycle/verification claims match live facts. Implementation-level fixture and calibration failures belong here.  
**Review:** sustain/reject each finding against current authority and code; do not demand Reviewer repair; do not turn review prose into routing. |
| **Owner** | `souls/judge.md` (reframe today’s universal “亲审测试质量” as apply-burden, not plan-burden) |
| **Red** | Apply bar weakened; or plan bar still forces apply-depth inspection before construction. |
| **Green** | Apply strictness retained and scoped; review independence retained. |
| **Scope** | No Reviewer/Collector/Coder/Fixer soul edits. |

### G. Role-law proof via recorded real Judge executions (replaces scripted oracle)

| | |
| --- | --- |
| **Behavior** | Package proves posture law in **both directions** with **checked-in artifacts from actual packaged Judge runs** after Soul rewrite: (1) unresolved contract/seam/oracle materials → **accepted blocking** verdict (`continue` or `escalate` as facts warrant) under revised Soul + **real** Soul audit pass; (2) construction-ready B/O/R/G/S plan that omits fixture mechanics → **accepted `converged`**, optionally with apply obligations in `note`, under revised Soul + **real** Soul audit pass. Both runs: packaged entrypoint (`--ak-role judge` / same loader path), only supplied artifacts, **no** posture flag, **no** persistent history, **no** topology hints. |
| **Owner** | Apply-time recording procedure + `test/fixtures/judge-postures/**` (names flexible) + offline validator test(s); Soul bytes under test = revised `souls/judge.md` |
| **Red** | Behavioral oracle is still `fauxProvider` told to emit statuses; or recordings lack real audit acceptance; or CI requires live paid model; or only one direction covered. |
| **Green** | Two checked-in recording bundles committed; offline CI asserts structural/acceptance facts (below); faux remains only where already justified as **transport** coverage (existing judge-role / package-entrypoint tests), explicitly not role-law proof. |
| **Scope** | No new harness family beyond thin offline validation of committed artifacts; no runtime classifier; no paid-model CI job. |

### H. Soul hygiene + principle tests (not phrase-fishing)

| | |
| --- | --- |
| **Behavior** | Necessary judgment present; process/schema/CLI/fixture-pseudocode/issue numbers absent. Replace phrase-grep soul tests with principle presence + pollution absence (mirror `reviewer-soul` / `collector-soul`). |
| **Owner** | `souls/judge.md`; `test/judge-soul.test.ts` |
| **Red** | Old Chinese fragment fishing remains sole soul gate; Soul bloated with issue text / fixture recipes / #1/#2 carriers. |
| **Green** | Principle-level presence for postures, authority burden, five facts, plan-converged meaning, blocker split, complete-first/late-finding, authority freeze, apply strictness, review independence; absence of `--ak-judge` posture flags, next-role, retry cap, workflow DSL, fixture pseudocode, Ming/host institutions, `packets/`. |
| **Scope** | No long rubric duplicated into README. |

### I. Unchanged package contracts

| | |
| --- | --- |
| **Behavior** | `converged \| continue \| escalate` (+ optional `note`); singleton `ak_judge_output`; Soul-compliance audit; tool narrowing to read/grep/find/ls/bash/output; infrastructure → fatal non-zero; caller independence. |
| **Owner** | `src/judge-role.ts`, `src/soul-auditor.ts`, existing role tests — **expect no behavioral code change** |
| **Red** | Schema/tool/flag/audit surface drifts; #1 seatbelt or #2 packets sneak in. |
| **Green** | `npm test` + `npm run typecheck` green; existing judge-role / package-entrypoint / audit-failure assertions still hold. |
| **Scope** | No Judge CLI phase/posture flags. |

---

## Proposed Soul shape (apply-time drafting guide; keep short)

Rewrite `souls/judge.md` as a tight kernel (~same length or modestly longer only if authority law cannot compress further):

1. **Identity** — adjudicate only; no code/commit.  
2. **Evidence** — claims ≠ evidence; only current-head materials are current fact.  
3. **Postures** — infer authority / plan / apply / review burden from materials; not flags/history/topology.  
4. **Authority completeness (new, compact)** — incomplete/contradictory public contracts & boundaries; state·time·evidence·trust semantics; irreversible owner choices; module/external seams; contradictions that make later work unsafe → block. Authority convergence does **not** require Apply evidence.  
5. **Plan readiness** — five facts; construction-ready when they cover authority and no readiness blocker remains; plan `converged` authorizes construction only.  
6. **Plan blocking law** — readiness blockers vs implementation-local apply obligations via `note`.  
7. **Complete-first / late-finding / authority freeze** — no numeric ceiling; current-invocation evidence only.  
8. **Apply proof (reframed)** — keep strict test/seam/boundary/surface audit **here**.  
9. **Review adjudication** — sustain/reject findings; no repair/routing demands.  
10. **Repair principles** — delete/simplify > parallel guards; three questions (keep).  
11. **Verdicts** — three statuses with **artifact-relative** meanings; optional advisory `note` (no routing).  
12. **Infrastructure** — not a verdict; fail closed.  
13. **Stuck / owner gates** — escalate; no fixed round brake.

**Delete/compress from current Soul:** apply-only wording inside the universal `converged` definition; any implication that every judgment requires “新 head 验证” before converge.

**Do not put in Soul:** exact fake arrays, helper names, CLI, schema catalogs, workflow examples, issue numbers (#1/#2/#3), retry counts, orchestration, packet template paths.

---

## Recorded-artifact design (role-law oracle)

### What “actual packaged Judge execution” means

At **apply time**, after `souls/judge.md` is rewritten, run **two real Judge sessions** through the packaged role path (same activation as production: package extension + `--ak-role judge`, model credentials from the operator environment — **not CI**):

| Recording | Supplied materials (only) | Required accepted outcome |
| --- | --- | --- |
| **R-block** | Authority/plan bundle with unresolved contract **or** unclear seam **or** missing red/green oracle (pick one clear blocker; materials must not be ambiguous about the missing readiness fact) | Soul-audited accepted **blocking** verdict (`continue` with fix naming the readiness blocker, or `escalate` if truly an owner gate). Must **not** be `converged`. |
| **R-ready** | Issue’s construction-ready B/O/R/G/S style plan (generic cross-leg contamination example is fine) covering authority; **omit** exact IDs, fake arrays, helper call syntax, byte-boundary field choice | Soul-audited accepted **`converged`**. Optional non-empty `note` listing apply obligations for fixture precision / boundary calibration. Must **not** refuse construction over mechanics-only gaps. |

**Constraints on both runs:**

- Revised bundled Soul bytes injected (not a host overlay substitute for the law).  
- Real Soul-compliance audit must **pass** (accepted path: `Judge verdict accepted` / non-error `ak_judge_output` details).  
- No `--ak-judge-posture` or any new flag; no prior Judge call history fed as package memory; no “next role” instructions; no topology DSL.  
- Materials are self-contained files checked in beside the recording (prompts + authority/plan text).  
- Operator records provenance metadata (model id, package HEAD SHA at recording, timestamp) in a small sidecar — metadata is evidence, not runtime input.

### Checked-in layout (names flexible; intent fixed)

```text
test/fixtures/judge-postures/
  README.md                 # how recordings were produced; offline-only CI note
  r-block/
    materials.md            # supplied authority/plan inputs
    prompt.md               # exact -p / user prompt
    meta.json               # model, packageSha, recordedAt, role flags used
    receipt.json            # accepted ak_judge_output details (+ audit pass marker)
    session.jsonl           # or minimal transcript extract proving soul+audit path
  r-ready/
    materials.md
    prompt.md
    meta.json
    receipt.json
    session.jsonl
```

Minimal acceptable receipt proof per bundle:

- `receipt.json` contains final accepted `details` (`judgeStatus`, optional `fix`/`note`/`decisionGate` per schema).  
- Evidence audit passed (e.g. tool result text `Judge verdict accepted`, `isError: false`, and/or audit decision `pass` visible in transcript).  
- Transcript/session shows `<judge_soul>` content matching **committed** `souls/judge.md` digest (hash pinned in `meta.json` or validator recomputes).  
- Flags/args show only existing Judge activation (`ak-role=judge`); assert absence of posture/history flags.

### Offline CI validation (no paid model)

New test file e.g. `test/judge-posture-recordings.test.ts`:

1. **Load** both bundles from disk.  
2. **Assert R-block:** `judgeStatus` ∈ {`continue`,`escalate`}; if `continue`, `fix.summary` non-blank and refers to a readiness-class gap (contract/seam/oracle — structural/keyword check against the **materials’ declared blocker class**, not a free-prose NL judge); audit-accepted marker present; soul digest matches current `souls/judge.md`.  
3. **Assert R-ready:** `judgeStatus === "converged"`; if `note` present, non-blank; materials omit fixture-mechanics specifics; audit-accepted marker present; soul digest matches current `souls/judge.md`.  
4. **Assert packaging invariants on recordings:** no posture flag strings; no next-role fields; verdict keys ⊆ existing schema.  
5. **Drift gate:** if someone edits `souls/judge.md` without re-recording, digest mismatch fails CI — intentional. Re-record procedure documented in fixture README (operator, not CI).

**Faux tests:** keep existing transport/integration coverage. Do **not** add new faux scripted posture “proofs.” If a tiny faux test is added, it must be labeled transport-only and must not be the acceptance oracle for cluster G.

**Optional non-oracle fixtures** (not substitutes for R-block/R-ready): static markdown examples used only by soul/README docs — never as verdict oracles.

---

## File-level construction slice (minimal)

| Path | Action |
| --- | --- |
| `souls/judge.md` | Rewrite kernel per Soul shape (include compact **authority** burden). |
| `README.md` | Thin Judge/Verdict note: postures inferred from materials; plan `converged` = construction authorization; authority completeness ≠ apply proof; `note` may carry apply obligations; no new flags. |
| `CONTEXT.md` | Optional one-line posture term; skip if README+Soul suffice. |
| `test/judge-soul.test.ts` | Replace phrase-grep with principle presence + pollution absence (incl. authority burden; excl. packets/flags/retry/DSL). |
| `test/fixtures/judge-postures/**` | Materials + two real recordings + meta + fixture README (re-record instructions). |
| `test/judge-posture-recordings.test.ts` (name flexible) | Offline CI validators for both recordings + soul-digest pin. |
| `src/judge-role.ts` / schema / CLI flags | **No change** unless accidental coupling appears (unexpected). |
| Worker/Reviewer/Collector souls; `packets/`; seatbelt; tracers | **No change** (#1 / #2 excluded). |

---

## Apply sequence (when authorized)

1. Rewrite `souls/judge.md` (kernel only; run CLAUDE.md Soul admission five questions).  
2. Replace `test/judge-soul.test.ts` with principle tests (authority + plan + apply + review + freeze/late-finding + pollution absences).  
3. Author **R-block** and **R-ready** material files.  
4. **Operator step (paid/real model, outside CI):** run two packaged Judge sessions under the new Soul; capture accepted receipts + transcripts + meta; verify audit passed and outcomes match cluster G.  
5. Check in recordings under `test/fixtures/judge-postures/`.  
6. Add offline validator test(s); wire into normal `npm test`.  
7. Thin README (CONTEXT only if term needed).  
8. Run full verification; fix only regressions at these seams.  
9. Stop — no amend/rewrite/push; report evidence in coder apply receipt (include recording provenance and soul digest).

**Ordering note:** recordings **must** be captured **after** final Soul text is stable. If Soul changes post-recording, re-record both bundles before claiming green.

---

## Verification plan

1. `npm test` — full suite green (offline; no network model).  
2. `npm run typecheck`  
3. Targeted:  
   `node --import tsx --test test/judge-soul.test.ts test/judge-posture-recordings.test.ts test/judge-role.test.ts test/package-entrypoint.integration.test.ts test/audit-failure-subprocess.test.ts`  
4. Manual Soul admission pass (CLAUDE.md five questions) recorded in apply report.  
5. Diff audit checklist:  
   - no new CLI flags  
   - no schema leaf changes  
   - no `packets/` / issue #2 templates  
   - no seatbelt / live tracer (issue #1)  
   - no orchestration / next-role / retry cap  
   - existing faux tests remain transport-only  
6. Recording integrity: both receipts audit-accepted; soul digest matches `souls/judge.md`; R-block blocked; R-ready converged (note optional).

---

## Risks / mitigations

| Risk | Mitigation |
| --- | --- |
| Soul bloat | Compress principles; refuse issue-bullet paste; admission Q5 prefers shorter. |
| Scripted-oracle regression | Cluster G forbids faux as behavioral proof; CI fails without real recordings. |
| Recording drift after Soul edit | Digest pin fails CI; fixture README documents re-record. |
| Silent apply weakening | Keep apply strictness explicit when moving test-quality language out of universal `converged`. |
| Authority law still thin | Cluster A full B/O/R/G/S + Soul section 4 + soul tests for authority blockers and “no Apply evidence required.” |
| Scope bleed into #1/#2 | Explicit exclusions in plan, soul pollution tests, and diff audit. |
| Over-fitting validators to one model’s prose | Validate status, audit acceptance, soul digest, and blocker-class alignment to materials — not full NL rubrics. |
| Paid model in CI | Forbidden; recordings are fixtures; CI is offline. |

---

## Mapping to issue acceptance criteria

| Criterion | Cluster / carrier |
| --- | --- |
| Distinguish authority / plan / apply / review without routing | A, B, Soul postures |
| Plan readiness B/O/R/G/S | C |
| Plan `converged` = construction authorization | C, Soul verdicts |
| Plan blocking law | D |
| Apply obligations via existing `note` | D, schema unchanged |
| Complete-first / late-finding without numeric ceiling | E |
| Authority freeze | A, E |
| Apply remains strict | F |
| Review adjudication independent | F |
| Verdict contract unchanged | I |
| Singleton / audit / narrowing / fatal / caller independence | I |
| No orchestration / DSL / next-role / retry / classifier / topology | Scope guard, H, I |
| Soul review: necessary present, process absent | H |
| Both directions proved | **G recorded artifacts + offline CI** |

---

## Done means

Construction is complete when:

1. Revised `souls/judge.md` carries irreducible posture + **authority** + plan + apply + review law without process pollution.  
2. Principle soul tests replace phrase-grep.  
3. Two real packaged Judge recordings (block + ready) are checked in, soul-digest-pinned, audit-accepted.  
4. Offline CI validates those recordings; no paid model in CI.  
5. README thin note landed; runtime/schema/flags unchanged; #1 and #2 surfaces absent from the diff.  
6. Full `npm test` + `typecheck` green.
