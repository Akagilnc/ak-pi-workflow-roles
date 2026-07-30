# Fixer plan — Issue #3 Apply residuals on 62596ba

**HEAD:** `62596ba` (clean). **Phase:** plan only — no edits, no commit.
**Authority:** issue #3 Judge burden / posture recordings only.
**Out of scope:** issues #1/#2; `src/**`, `schemas/**`, `extensions/**`, package/lock, other Souls, runtime/verdict/singleton/audit/tool/fatal contracts.

Proven forge facts on current code:
- `extractAcceptedJudgeOutputs` treats missing `isError` as success (`isError === true` is the only reject); details-keyed dedupe collapses two distinct accepted calls with identical details → length 1.
- Recorded user prompts append absolute paths under `.../judge-postures/r-block|r-ready/...`; r-block session contains ~20 `r-ready` hits via repo-wide grep of the live fixture tree.
- Offline check only runs `assertNeutralModelInputs` on static `input/*`, not JSONL user/read bytes.
- `souls/judge.md:44-46` is a fixture-detail catalog; `test/judge-soul.test.ts` positively requires `fake|夹具|helper|字节` and pollution regex misses the Chinese/mixed catalog wording.

---

## Residual 1 — Opaque neutral recordings + JSONL-bound input trust

| | |
| --- | --- |
| **Behavior** | Model-visible recording inputs must carry no readiness-direction labels or expectation sidecars; offline oracle must validate the **actual** user-prompt and materials-read bytes from JSONL, not only static `input/*`. |
| **Owner** | `test/judge-posture-recordings.test.ts` + `test/fixtures/judge-postures/**` recording procedure (`README.md` operator notes). |
| **Red** | (a) Session whose user message or materials read path/content exposes `/r-block/`, `/r-ready/`, `expected.json`, or coaching answer keys still passes. (b) Static `input/prompt.md` neutral while JSONL user text is labeled/coached still passes. |
| **Green** | Both bundles re-recorded as real packaged/audited Judge runs under opaque workspaces/paths; JSONL-derived user prompt + materials-read content are neutral and free of direction labels/sidecars; static `input/*` bytes equal those JSONL-derived surfaces (bind); external `expected.json` / `meta.json` remain offline-only. |
| **Scope** | No runtime/role changes. Offline bundle **directory names** may stay `r-block`/`r-ready` as oracle labels outside the recorded model world. |

### Evidence (current)

- README `record()` appends `Materials path: $dir/input/materials.md` → labels land in JSONL user message (confirmed `message_end` user text).
- r-block grepped package root and returned `test/fixtures/judge-postures/r-ready/input/materials.md` in tool results.
- Validator never extracts user/read bytes from JSONL.

### Repair steps (apply)

1. **Recording harness (operator procedure, update fixture README)**  
   For each case, use a **detached opaque workspace**, e.g. temp dirs with non-directional names (`case-a` / `case-b` or random tokens), containing only:
   - case `materials.md` (+ optional neutral prompt stub)
   - access to the **packaged** role via `-e <package>`  
   Package checkout used for `-e` must **not** expose sibling direction-labeled fixture trees to the model (record from a worktree/export with `test/fixtures/judge-postures` absent or renamed, or otherwise unreachable). Do **not** place `expected.json` / `meta.json` in the model-reachable workspace.  
   Prompt must not embed oracle dir names; materials path must be opaque. Keep materials substance (block = missing Red/Green oracles; ready = full five facts) so direction still comes from case content, not path labels.  
   Real run: `pi --no-extensions -e <pkg> --no-skills ... --mode json --ak-role judge -p '...'` → capture `session.jsonl`. Derive `receipt.json` from sole accepted verdict; write `meta.json` with new `soulDigest` + provenance. Copy opaque materials/prompt into offline `input/` after the run.

2. **Offline validator upgrades** in `test/judge-posture-recordings.test.ts`:
   - `extractUserPromptText(rows)` from JSONL user `message_end` (authoritative; ignore stream deltas).
   - `extractMaterialsReadText(rows)` from successful `read` toolResult whose path is the materials path cited in that user prompt (bind path + body).
   - Run neutrality denylist on **JSONL-derived** prompt + materials text (keep/extend denylist).
   - Deny model-visible direction/sidecar leakage in those surfaces and, minimally, in JSONL user text + materials-read path/body: `/r-block/`, `/r-ready/`, `expected.json`, readiness path tokens.
   - Assert static `input/prompt.md` is a prefix/body equal to the adjudication instructions in JSONL user text (or full equality of the instruction portion), and static `input/materials.md` **byte-equals** JSONL materials-read content.
   - Retain soul-in-session + digest pin + receipt cross-check + external `expected.json` direction assert.

3. **Re-record both** bundles after Soul residual 3 (soul bytes change invalidates digests). Order: Soul text → record both → pin `meta.soulDigest`.

---

## Residual 2 — Non-forgeable acceptance parser + negative probes

| | |
| --- | --- |
| **Behavior** | JSONL acceptance requires explicit success, tool-call identity uniqueness, and exactly one distinct accepted `ak_judge_output`. |
| **Owner** | `extractAcceptedJudgeOutputs` / acceptance assertions in `test/judge-posture-recordings.test.ts` only. |
| **Red** | (1) Accepted event with **missing** `isError` still counts. (2) Two accepted ends with **different** `toolCallId` and identical details collapse to one and pass. (3) Coached/raw-input mismatch (static neutral, JSONL user or materials-read coached/labeled) still passes. |
| **Green** | Each probe fails offline; honest single-call sessions with `isError === false` still accept exactly once. |
| **Scope** | Test-local parser only — do not change `src/judge-role.ts` acceptance runtime. |

### Repair steps (apply)

1. Acceptance predicate:
   - Require **`isError === false`** (reject `undefined` / missing).
   - Keep `Judge verdict accepted` text + object `details`.
   - Carry `toolCallId` (require non-empty string on accepted events).
2. Identity:
   - Collect by `toolCallId` (stream `tool_execution_end` + `message_end` representations of the **same** id merge).
   - After merge, **`acceptedDistinct.length === 1`** — duplicate distinct ids fail even if details stringify equal.
3. Negative tests (synthetic JSONL; no paid model):
   - **missing `isError`** → 0 accepted / bundle validation throws.
   - **duplicate distinct `toolCallId`s**, same details, both explicit `isError:false` + accepted text → fail exactly-one.
   - **coached/raw-input mismatch**: static `input/*` neutral; JSONL user prompt contains direction label or coaching (or materials-read body ≠ static materials / contains coach keys) → fail new bind/neutrality checks from residual 1.
4. Keep existing receipt-only forge probe (no accepted marker).

---

## Residual 3 — Judgment-only Soul principle (no fixture catalog)

| | |
| --- | --- |
| **Behavior** | Soul keeps the irreducible rule that Apply-decidable local mechanics are not plan blockers (via optional `note`), without embedding implementation-local example catalogs. |
| **Owner** | `souls/judge.md` Plan section + `test/judge-soul.test.ts`. |
| **Red** | Soul still lists helper/function/file names, fake arrays/fixture literals, library call syntax, table-driven vs discrete tests, byte-calibration field choice, etc.; hygiene test requires those terms or fails to deny Chinese/mixed catalog wording. |
| **Green** | Principle present in short form; catalog gone; tests require principle presence and deny catalog/pollution terms (EN + 中文); soul digest re-pinned on both recordings. |
| **Scope** | Judge Soul + its hygiene test + forced recording refresh only. No other Souls. No schema/runtime. |

### Repair steps (apply)

1. Replace `souls/judge.md:44-47` catalog with a short principle, preserving meaning roughly:
   - After the five facts are set, **Apply-decidable local mechanics / implementation details are not plan blockers**; carry them as optional `note` Apply obligations; do not demand another plan-prose rewrite.
   - Do **not** enumerate helpers, fakes, fixture literals, call syntax, test layout, or byte-field choices.
2. Keep surrounding law: plan blockers list, complete-first / late-finding, authority freeze, Apply strict proof, Review adjudicative.
3. `test/judge-soul.test.ts`:
   - Presence: plan-blocker-vs-Apply-obligation / `note` / “not plan blocker” (or 中文等价) — **without** requiring `helper|fake|夹具|字节` catalog tokens.
   - Pollution: extend denylist for catalog residue (`helper/函数/文件名`, `fake 数组`, `夹具字面量`, `库调用语法`, `表驱动`, `分立测试`, `字节边界`, `exact fake array`, `helper call syntax`, etc.) and keep existing process/schema/flag forbids.
4. Because Soul bytes change: **regenerate both recordings** and update both `meta.soulDigest` (and receipts/sessions as produced).

---

## Apply order (single forward commit family)

Recommended one commit (or tightly stacked forward commits if split is clearer — prefer **one**):

1. Soul principle rewrite + soul hygiene test fix (residual 3 text/tests).
2. Hardened acceptance parser + JSONL input binding + negative probes (residuals 1–2 test code); update fixture README re-record procedure.
3. Operator: opaque-workspace re-record `r-block` + `r-ready`; write sessions/receipts/meta; ensure static `input/*` matches JSONL-derived bytes.
4. Verify:
   - `git diff --check`
   - `npm run typecheck`
   - `node --import tsx --test test/judge-soul.test.ts test/judge-posture-recordings.test.ts`
   - full `npm test`
   - Confirm no changes under `src/**`, `schemas/**`, `extensions/**`, package/lock, other souls.
   - New HEAD strict forward descendant of `62596ba`; no amend.
5. Commit title prefix per repo convention, e.g. `fix(judge): ...`; body cites the three residuals and non-adopted items (none expected if all land).

### Non-goals / refuse conditions

- Do not relax `expected.json` direction asserts or delete failing oracle paths to go green.
- Do not “fix” neutrality by stripping labels only from static `input/prompt.md` while leaving labeled paths in JSONL.
- Do not keep Soul catalog under a synonym list.
- If real re-record cannot be completed (no credentials/model), **refuse apply** with evidence rather than hand-editing fake JSONL acceptance.

### Risk note

Re-record is the only paid/flaky external step; validator+parser+Soul edits are deterministic. If a fresh run yields unexpected direction vs `expected.json`, treat as case-materials/oracle problem — adjust **opaque case materials** (still neutral, still no path labels), not the acceptance bar.
