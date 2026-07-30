## Construction-readiness plan — frozen issue #2

### Baseline / authority bind
- Work only from clean HEAD `c04d24e19390cab239b8c7e31c7ccb9a8975ad18` (`git status --short` is empty).
- Current facts rechecked: `packets/` has no files; `docs/development-closure.md` does not exist; `CLAUDE.md` has no probe rule; `package.json#files` is exactly `extensions`, `src`, `souls`, `schemas`, `README.md`.
- Applicable owners: frozen issue text; `souls/judge.md` for posture semantics; ADR 0010 for caller-owned composition; ADR 0011 for avoiding universal provider law. The new documents consume these owners and do not amend them.

## Five caller-owned packet templates

### 1. `packets/judge-authority.md`
- **Behavior:** A repository contributor can manually instantiate an Authority-evidence packet containing authority clauses, decisions, counterexamples, boundaries, and unresolved owner choices. Every supplied artifact is identified by repository-relative path plus SHA-256 of exact bytes. The template says a digest seals identity only—not truth, acceptance, or freshness—and does not demand Apply proof.
- **Owner:** This contributor template owns only its manual evidence layout; Judge posture meaning remains solely in `souls/judge.md`, while selection/composition remains caller-owned.
- **Red:** At the frozen HEAD no such template exists; authority evidence cannot be recorded in a repository-standard, identity-sealed form.
- **Green:** Inspection of an instantiated example can recover each authority item and exact artifact identity without implying a verdict, phase flag, transition, predecessor/successor, or mechanically validated trust level.
- **Scope:** No Apply evidence requirement; no orchestration, routing, package memory, resume semantics, timeout budget, or changes to Judge law/contracts/audit.

### 2. `packets/judge-plan.md`
- **Behavior:** A contributor can seal the applicable authority identity and record exactly the five readiness facts—Behavior, Owner, Red, Green, Scope—for each proposed change. Artifact references use repository-relative path + exact-byte SHA-256. It avoids fixture pseudocode and blanket `file:line` demands.
- **Owner:** Template structure only; Plan semantics remain in `souls/judge.md`; artifact acceptance remains caller-owned.
- **Red:** No current standard artifact binds a construction plan to sealed authority while making all five facts reviewable.
- **Green:** Manual inspection can reconcile every planned change to sealed authority and all five facts, with local Apply-decidable mechanics left as Apply obligations rather than invented plan blockers.
- **Scope:** No proof that construction occurred; no verdict inferred from filename; no topology or role-order claims.

### 3. `packets/judge-apply.md`
- **Behavior:** A contributor can bind sealed authority and plan identities to completed construction evidence: repository-relative path + exact-byte SHA-256 for artifacts, the full target commit SHA for code/apply facts, and full base/target SHAs where a range is claimed. It records live code/tests, real production-seam and boundary evidence, and uses `file:line` only where applicable. Guardrail-triad evidence appears only when adding or approving a guardrail.
- **Owner:** Contributor evidence template; Git commit identity owns code snapshot/range identity; Judge Apply meaning remains in the Soul.
- **Red:** No present template distinguishes byte identity, target snapshot identity, review range, and behavioral evidence.
- **Green:** A reader can independently check claims on the named full target/range and can distinguish: digest = artifact bytes; target SHA = complete code state; base→target SHAs = reviewed delta; tests/seam/boundary observations = behavioral evidence. The packet does not claim any of these alone proves truth or acceptance.
- **Scope:** No new receipt envelope, audit, runtime enforcement, trust tier, production hook, or package surface.

### 4. `packets/judge-review.md`
- **Behavior:** A contributor can bind each independent finding and its disposition to sealed authority, a fixed reviewed range (full base and target SHAs), and current target facts. It records adjudication evidence without defining Reviewer protocol.
- **Owner:** Contributor review/adjudication record only; Reviewer’s existing method/audit and Judge Review semantics retain their current owners.
- **Red:** Current repository has no standard way to show that each finding/disposition concerns one immutable range and current facts.
- **Green:** Every finding has an explicit disposition and evidence binding; changed target or range requires a new artifact/digest rather than silent mutation.
- **Scope:** No generic Reviewer/Collector provider law, no required review order/repetition, no routing back to any role, and no alteration of Reviewer audit or Collector ledger semantics.

### 5. `packets/fixer-repair.md`
- **Behavior:** A contributor can issue a forward repair artifact enumerating one exact, unique set `R1..Rn` and requesting a Markdown report table with rows `R# -> implemented(test name) | refused(reason)`. The packet explicitly requires manual exact-set reconciliation before the artifact is accepted into this repository’s development trail.
- **Owner:** Template owns the contributor-facing repair request; current Fixer output remains the thin `status`, Markdown `report`, optional `commitSha` contract in `src/worker-role.ts`.
- **Red:** No current template supports exact manual reconciliation of repair items; current runtime cannot and does not enforce an `R#` ledger.
- **Green:** A maintainer manually verifies that report keys equal the packet’s unique `R1..Rn` set exactly—no missing, duplicate, or extra keys—and records acceptance/disposition externally in the trail.
- **Scope:** Must not claim Judge origin, Fixer destination, return-to-Judge flow, mechanical enforcement, Soul-compliance audit, receipt-envelope enforcement, or cross-role ledger. Such runtime/schema work requires separate authority.

## `docs/development-closure.md` — contributor-only closure
- **Behavior:** Document this repository’s canonical manual dogfood record: (1) seal authority inputs, (2) record any authority judgment, (3) seal a five-fact construction plan, (4) preserve construction receipt/commit/test evidence, (5) record Apply judgment, (6) preserve independent review plus per-finding adjudication, and (7) issue a new forward repair artifact when needed without overwriting prior artifacts. An inapplicable beat may be omitted only with explicit disposition. Accepted artifacts retain exact bytes/digest and receipt; amendments/replacements use a forward commit/new digest and explicitly dispose the prior artifact. Verdicts live in receipts/trail, not filenames; restart/compaction recovery is manual rereading.
- **Owner:** Repository contributor/dogfood practice only.
- **Red:** The current repository has no closure checklist or durable manual sequence.
- **Green:** A maintainer can audit a development trail beat-by-beat, including explicit omissions, immutable prior records, exact manual `R#` reconciliation, and independent review dispositions.
- **Scope:** Descriptive host practice—not packaged workflow authority, generic role ordering, package memory, transition machine, mechanical gate, or runtime budget.

## `CLAUDE.md` — concise probe lifecycle paragraph
- **Behavior:** Add one concise host-level paragraph: a probe is temporary evidence; once its evidence purpose is disposed, either delete it or graduate its behavior exactly once into the regression suite owned by the affected seam, then delete the scratch copy. Only a bare-seam probe unreachable by ordinary tests may remain under `test/adjudication/`.
- **Owner:** Repository probe hygiene in `CLAUDE.md`; the affected production seam owns any graduated regression.
- **Red:** Current guidance permits ambiguous scratch retention and duplicate permanent test shapes.
- **Green:** Each disposed probe has exactly one observable fate: deleted, or represented once in the owning regression suite with scratch removed; exceptional retained probes satisfy the bare-seam/unreachable condition.
- **Scope:** No Judge-origin label, role destination, `/tmp` as truth, duplicate permanent shape, or bundled Soul content.

## Construction cut and verification
1. Create only the five named `packets/*.md` files and `docs/development-closure.md`; make one targeted paragraph addition to `CLAUDE.md`. Keep prose explicit that filenames identify evidence burdens, not verdicts/stages/topology.
2. Same-pattern/content checks: use `rg` over the seven authorized files for required terms and prohibited claims; manually inspect distinctions among path/digest, full target SHA, full base/target range, and behavioral evidence; verify each packet states caller ownership and does not duplicate Judge posture law.
3. Scope check with `git diff --name-only c04d24e...HEAD`: exact allowed set only. Use `git diff -- README.md souls schemas src extensions package.json test` (and audit/receipt-related paths) to prove no README, Soul, schema, runtime, audit, receipt, test, topology implementation, or provider-law changes.
4. Regression checks: run `npm test` and `npm run typecheck`. Frozen baseline is currently **259/259 passing** and typecheck passing.
5. Package exclusion proof: preserve `/tmp/issue2-pack-before.json` baseline from `npm pack --dry-run --json` (26 entries, package size 61,062 bytes; neither `packets/` nor `docs/` appears). After construction, generate a second JSON pack manifest and compare sorted `files[].path` arrays exactly. Require zero path differences, 26 entries, and explicit absence of `packets/`, `docs/`, and `CLAUDE.md`. Byte size may vary only if packaged files changed—but none are authorized—so it should also remain unchanged; the authoritative claim is unchanged path list plus excluded repository-only files.
6. Introduced-regression/behavior-fact check: confirm clean successful tests/typecheck, exact authorized diff, unchanged packlist paths, and manually instantiate/check one sample per template mentally or in disposable untracked scratch (deleted afterward) to ensure required identities/evidence can be filled and that `R1..Rn` exact-set reconciliation is possible without runtime claims.

No edits are made in this plan phase.
