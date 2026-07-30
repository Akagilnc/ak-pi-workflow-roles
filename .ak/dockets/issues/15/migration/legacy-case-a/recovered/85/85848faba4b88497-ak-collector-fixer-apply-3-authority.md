# Approved Collector repair plan 3

# Collector repair packet 3 — construction-readiness plan (b43bf20)

Baseline HEAD: `b43bf20`. Plan only; no edits, tests, or commits.

Prior same-seam commit `b43bf20` already attempted F1–F3 closure but left residual dual schema acceptance, mislabeled F2 decoys, and tests that stop short of their claimed seams. Do not re-ship the same method family (diagnostic parse fallback, output+output sibling, `skillsOverride` ambient skill name, `outputExecuteEntered` set while synthesizing the assistant call, retention assertions that end at `allEvidence()`).

---

## F1 — Singular schema ownership + exact oracles

**Behavior**
- `parseCollectorOutputCandidate` has one acceptance path: `Value.Check(collectorOutputArgsSchema, raw)` then a typed copy/transform of accepted legs.
- Schema failure is one generic failure (no manual top-level/leg key lists, status/rationale/ref/scope diagnostics, or post-Check `unavailableScope` re-validation).
- Oracles prove shared Check/batch ownership for observe `undefined|null|{}` and every malformed output row; registered output union’s three strict variants; real-Pi sibling = valid operational `observe` + invalid `output`; well-formed missing / unavailable / multiline as separate controls; every invalid/sibling row ends fatal/nonzero with all six GitHub counters at zero.

**Owning seam**
- Production: `src/collector-receipt.ts` `parseCollectorOutputCandidate` only (delete diagnostic branch ~100–160 and redundant scope post-check ~179–186).
- Schema true source stays `src/collector-tool-schemas.ts` (already status-discriminated; no schema redesign unless an oracle proves a gap).
- Shared Check already lives in `collectorToolArgumentsValid` / batch classify (`src/collector-ledger.ts`); extend **tests** to exercise it, don’t fork a second validator.
- Oracles: `test/collector-receipt.test.ts` F1 matrix + `test/collector-role.test.ts` F1 schema inspection / real-Pi / controls.

**Red oracle (current)**
- Parse still hand-validates after `Value.Check` fails and re-checks scope after success.
- Registered-schema test only asserts `properties.legs !== undefined` (vacuous).
- Real-Pi invalid rows assert only pull/user/create (not all six) and sibling is output+output.
- Controls collapse missing/unavailable/multiline into one path.

**Green oracle**
- Invalid parse → single generic schema failure; valid legs copy through without secondary scope gate.
- Schema inspection walks registered union `anyOf` (or equivalent) and asserts three strict variants: `valid` / `unavailable` / `missing`, `additionalProperties: false`, `unavailableScope` only on unavailable.
- Shared-check/batch matrix: observe `undefined|null|{}` illegal; each malformed output row illegal at classify/batch.
- Real-Pi: each invalid output row + observe+invalid-output sibling → exit/fatal nonzero; `user|pull|reviews|issueComments|reviewComments|create === 0`.
- Separate well-formed controls for missing, unavailable, and multiline rationale (schema-accepted; not denied as schema-invalid).

**Unchanged scope**
- `collectorOutputArgsSchema` shape and batch classifier mechanics.
- `buildCollectorReceipt` leg-ownership / business rules (not schema).
- No new parallel parse or error-taxonomy layer.

---

## F2 — Mandated decoys + leg/terminal-report ref parity

**Behavior**
- Unavailable decoy matrix makes **one call each** for the five mandated decoys:
  1. cross-leg authenticated requester marker/comment
  2. cross-leg expected-author evidence
  3. after-window evidence
  4. actual unrelated PR evidence id
  5. actual unrelated snapshot id
- Dangling / wrong-author may remain as extras only; they are not substitutes.
- Clean legs, and the non-contaminated leg in missing / latestRelevant fixtures, assert **both** leg `evidenceRefs` and matching `terminal-fact` report `evidenceRefs`.

**Owning seam**
- Primary: `test/collector-receipt.test.ts` F2 block (`F2-latestRelevant-*`, two-leg missing contamination, M1–M3b, U1–U5).
- Production `buildCollectorReceipt` / `missingCiteAllowed` / unavailable qualification **only if** a mandated decoy is incorrectly accepted (packet forbids broadening ownership without that counterexample).

**Red oracle (current)**
- “U1–U5” are mislabeled: wrong-author, cross-leg author proof, snapshot cite, dangling, after-window — not the five mandated decoys (no requester-marker cross-leg, no unrelated PR/snapshot ids as first-class rows).
- latestRelevant / missing-clean paths assert leg refs incompletely relative to terminal-fact parity (latestRelevant checks reportA for leg a; missing contamination and M-clean omit matching terminal-report refs on clean / non-contaminated legs).

**Green oracle**
- Each of the five mandated decoys fails closed in isolation (message may stay ownership/disallowed/non-eligible class already emitted).
- Clean two-leg unavailable: leg + terminal-fact refs match per leg (proof only).
- latestRelevant recovered-then-succeeded: leg a + terminal a carry only latestRelevant cites; leg b + terminal b uncontaminated.
- Missing contamination / M-clean: non-contaminated (and clean) legs have leg refs ≡ terminal-fact refs for required proof ids.

**Unchanged scope**
- Production auto-link / allow-list logic unless a mandated decoy is accepted today.
- No new ref-ownership subsystem; no widening missing cites “for test convenience.”

---

## F3 — Cross the claimed seams (retention / ambient / overflow)

**Behavior**
- Retention: three tests (edit / dismiss / disappearance), each builds a receipt and asserts historical **review** report variants and those reports’ own evidence refs (not merely ledger retention via `allEvidence()`).
- Ambient/required-tool: each row reaches its claimed seam, asserts that seam’s fatal reason, provider unused, and all six GitHub counters zero.
- Ambient-skills must hit `before_agent_start` → `systemPromptOptions.skills` guard (not die earlier as `skill:ambient-collector-skill` during activation/resource load).
- 32 MiB role path: evidence from output **execute/failure** lifecycle (not a flag set while building the assistant message); assert `collectorFatal` and reported serialized size **exactly** `COLLECTOR_RECEIPT_MAX_BYTES + 1`.

**Owning seam**
- Retention oracles: `test/collector-receipt.test.ts` (split `F3 review edit/dismiss/disappearance retention`); production emitter already `collectSubstantiveReviewReports` in `src/collector-receipt.ts` — tests must cross it via `buildCollectorReceipt`.
- Ambient/required/overflow oracles: `test/collector-role.test.ts`; production guards already in `src/collector-role.ts` (`before_agent_start` skills/context/append; activate required-tools; output execute → `latchFatal` on overflow).
- Skills fixture must be in-process and inject/reach `event.systemPromptOptions.skills` without failing activation on skill-name loading.

**Red oracle (current)**
- One bundled retention test stops at `allEvidence()` bodies/states; no receipt, no review-report refs.
- `F3-ambient-skills` uses `skillsOverride` named `ambient-collector-skill` and fails earlier at activation rather than the `systemPromptOptions.skills` message.
- Ambient/required rows assert only partial counters (pull/user/create) and not seam-specific fatal reasons / provider unused.
- Overflow sets `outputExecuteEntered = true` in the faux response factory before execute; asserts message regex only — not `collectorFatal` or exact `MAX+1` byte count in the failure.

**Green oracle**
- Edit test: receipt contains review report for pre-edit and post-edit variants with each variant’s evidence refs.
- Dismiss test: receipt retains dismissed (and prior) review report variants + refs.
- Disappearance test: receipt still reports the disappeared review variant + refs after it leaves the live GitHub list.
- Ambient-skills: fatal reason matches skills/`systemPromptOptions` guard; `faux` unused; six counters zero; exit nonzero.
- Ambient contextFiles / appendSystemPrompt: each asserts its specific latch message; provider unused; six counters zero.
- Required-tool absence: specific missing-tool fatal; provider unused; six counters zero.
- Overflow role path: failure originates from output execute path; `collectorFatal === true`; error reports byte count `COLLECTOR_RECEIPT_MAX_BYTES + 1`; no successful output; create stays 0.

**Unchanged scope**
- Production review-report emission, ambient guards, and 32 MiB latch formula unless a green oracle exposes a real seam miss (packet is test/construction residual; do not invent parallel guards).
- Builder-path MAX/MAX+1 unit test remains; only role-path overflow oracle is corrected.

---

## Apply order (when approved)

1. F1 production parse deletion (smallest owning fix) + F1 unit generic-failure expectation.
2. F1 oracles (schema variant inspection, shared-check matrix, real-Pi sibling/controls, six counters).
3. F2 decoy relabel + terminal-report parity assertions; touch production only on exact false-accept.
4. F3 retention split + ambient seam fixtures + overflow execute/failure assertions.
5. Run declared collector typecheck/tests; one forward commit; no amend.

## Risk / refuse triggers

- Refuse if packet demands production ownership broadening without a failing mandated decoy.
- Refuse if ambient-skills green requires host APIs unavailable in-process and no honest fixture can reach `before_agent_start` without changing product contract — report evidence for judge.
- Do not weaken assertions, delete failure paths, or “pass” by catching activation errors as stand-ins for the claimed seam.


## Binding Apply obligations

Plan posture is construction-ready at b43bf20: F1–F3 each state Behavior, owning seam, Red oracle, Green oracle, and unchanged Scope; the packet’s contract is preserved, alternatives are constrained to owning mechanisms, and no unresolved contract/seam/oracle/feasibility decision remains. Independent baseline checks passed (`npm run typecheck`; 50 ledger/receipt tests; 9 targeted role tests), while source/test inspection confirms the stated residuals are real despite that green baseline. Apply obligations (implementation-local, no plan rewrite): create actual unrelated-PR evidence and unrelated snapshot IDs from separate real ledger fixtures rather than fabricated dangling IDs; make the ambient-skills fixture enter the captured/real `before_agent_start` handler with nonempty `systemPromptOptions.skills` without loading a skill command; for every ambient/required row assert the seam-specific fatal text, provider non-invocation, and all counters `user|pull|reviews|issueComments|reviewComments|create` remain zero; instrument the registered output tool’s execute/failure boundary for overflow and assert the captured error has `collectorFatal === true` and reports exactly 33554433 bytes; and have each retention fixture build a receipt and match each historical review report’s own refs to its retained review variant.
