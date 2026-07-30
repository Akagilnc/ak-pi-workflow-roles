# Plan: six current-head Collector seams at 6604a73

**HEAD:** `6604a733886dfb5d074f558963e20e01e587aa6d` (clean; suite green but missing the six paths).  
**Constraints:** repair at existing owners only; no Collector Soul edits; no parallel classifiers; no AC weakening; preserve disposed roots (R1/R2/R5/R6/R7/R8/R9/R10/R11 and prior first-order fixes).  
**Phase:** plan only — no code, test, doc, or Git mutation.

---

## 1. Target-scope unavailability provenance

| | |
|---|---|
| **Behavior** | `target` unavailable must rest on **evidence-carried exact-HEAD provenance**, not snapshot membership / first-observation HEAD. Head-bearing `review` / `review_comment` qualify for `target` only when `commitOid === targetHead`. Headless `issue_comment` has no HEAD field → **cannot** qualify as `target` (no new binder; “explicit binding” is the carried `commitOid`). `global` unchanged (author + before/within window only). |
| **Owner** | `src/collector-receipt.ts` — `qualifiesUnavailableEvidence` (delete/replace `establishedHeadFor`) |
| **Red** | Collector activates on H2 and first observes an H1 review (`commitOid: H1`): current `establishedHeadFor` returns H2 → accepts `unavailableScope: "target"` and stamps `targetSnapshotHead: H2`. Same class: headless issue comment first seen on H2 wrongly target-ok via first snapshot. |
| **Green** | H1 review first seen on H2 → `target` rejected; may still pass `global` if window/author ok. Exact-head review/review_comment on `targetHead` still proves `target`. Issue comments only via `global`. Prior H1-established-still-on-H2 rejection retained (stronger: provenance, not establishment). |
| **Scope** | Replace establishment-HEAD check with carried-HEAD check; remove `establishedHeadFor`. Rewrite the “first established on final HEAD accepts as target” issue-comment case to either reject or use a head-bearing fixture. **Do not** reintroduce snapshot-membership as target proof. |

**Prior failure family:** R3 residual (`c86c2a2` introduced `establishedHeadFor` as “establishment HEAD”; still relabels by first snapshot). Do not ship another membership/first-seen variant.

---

## 2. Request-path AbortSignal / hung POST cancellation

| | |
|---|---|
| **Behavior** | Tool `AbortSignal` must reach the owned `gh` POST child. Cancel stays cancel: throw abort; **not** `rejected` attempt; **not** late successful tool result; child killed (same runner seam as observe). |
| **Owner** | Thread only: `src/collector-role.ts` (`ak_collector_request` execute) → `src/collector-ledger.ts` (`request(..., signal?)`) → `src/collector-github.ts` `createIssueComment({ signal })` (runner already kills on abort). |
| **Red** | Role ignores `_signal`; `ledger.request` omits signal; POST `createIssueComment` never receives it. Hung POST cannot be cancelled through the request tool path. |
| **Green** | (1) Real hung POST via `createGhApiRunner` + abort → rejects `/abort\|cancel/i`, child dead, single settlement. (2) Ledger/role: abort does not set attempt `rejected` or return success details; existing abort rethrow in `createIssueComment` preserved. |
| **Scope** | Optional `signal` on ledger `request` signature + pass-through. No new cancel classifier. Do not mark cancel as `ambiguous_loss`/`rejected`. Leave process-local `attemptKeys` one-shot as-is unless a test proves double-success; packet does not require post-cancel retry. |

**Distinct from R11** (observe/GET cancel already fixed). Mirror R11 fixtures for POST only.

---

## 3. After-deadline first observation must not backdate via `submitted_at`

| | |
|---|---|
| **Behavior** | A review **version first seen only after the deadline** must not take `authoritativeTime = submitted_at`. Keep `null` → `windowRelation: "uncertain"` so it cannot prove valid/unavailable. Known-version path still reuses stored null/uncertain (R5). First version first seen **at/before** deadline may still use `submitted_at`. |
| **Owner** | `src/collector-evidence.ts` — `applyEvidenceVersionHistory` (deadline-aware first-version branch; ledger already has `deadlineTime` at the call site). |
| **Red** | First observe after cutoff of a never-seen review with pre-cutoff `submitted_at` → `authoritativeTime = submitted_at` → `before`/`within` → accepted unavailable/valid. |
| **Green** | After-cutoff first observation → `authoritativeTime === null`, `uncertain`; receipt rejects unavailable/valid on that alone. R5 third-observe null reuse still green. New **receipt-path** test: after-cutoff first-seen → terminal path fails closed. |
| **Scope** | Extend history helper with deadline (or equivalent evidence-layer input from `firstObservedAt` + deadline). No change to comment `updated_at` rules. No Soul/schema churn. |

**Distinct from R5** (edited later version / known-version reuse). This is first-seen-after-cutoff of a version.

---

## 4. 2xx POST parse/normalize failure → ambiguous loss + marker recovery

| | |
|---|---|
| **Behavior** | After HTTP 2xx, parse/normalization failure is **ambiguous response loss** (comment may exist), not `rejected`. Route through existing `ambiguous_loss` → ledger marker recovery on later observe. Non-2xx stays `rejected`. |
| **Owner** | `src/collector-github.ts` — `createIssueComment` success branch (try/catch around `parseJson` + `normalizeIssueComment` → `ambiguous_loss`). Ledger recovery path already handles markers. |
| **Red** | Malformed/truncated/required-field-missing 201 body throws into catch → `kind: "rejected"` → blocks recovery / may allow erroneous repost semantics. |
| **Green** | Malformed JSON, truncated body, missing required fields on 2xx → `ambiguous_loss`. Later observe sees authenticated same-marker comment → `recovered`; no second POST. Non-2xx still `rejected`. |
| **Scope** | Localize to 2xx parse path only. Do not reclassify transport-level `ambiguousGhFailure` or abort. Reuse existing recovery; no parallel recovery mechanism. |

---

## 5. Inline reply author ownership for report attachment

| | |
|---|---|
| **Behavior** | Do not attach another account’s inline reply to a configured reviewer’s report solely by `pull_request_review_id`. Report membership requires **matching author ownership** with the parent review (`authorLogin` equal, case already normalized at ingest). Intruder rows remain in the self-contained ledger/raw snapshot. |
| **Owner** | `src/collector-receipt.ts` — `reviewInlineComments` only. |
| **Red** | `intruder` `review_comment` with same `pull_request_review_id` is rendered/cited in the Codex (expected-author) report `evidenceRefs` / inline text. |
| **Green** | Intruder body absent from configured reviewer’s report and refs; parent review body still cited; intruder evidence still present via `ledger.allEvidence()` / snapshot ids. Existing same-author inline edit/removal variant tests stay green. |
| **Scope** | Minimal filter on author match. No drop from ledger. No new classifier types. |

---

## 6. Published request-body schema ↔ runtime parity

| | |
|---|---|
| **Behavior** | Published contract matches runtime: trim-non-empty body + ≤ 60_000 UTF-8 bytes. Schema: nonblank constraint (`pattern` requiring `\S`) + explicit byte-limit annotation/metadata (JSON Schema cannot express UTF-8 bytes). Runtime `loadCollectorManifest` remains enforcement authority for bytes. |
| **Owner** | `src/collector-config.ts` (`COLLECTOR_LEGS_SCHEMA`) **and** `schemas/collector-legs-v1.schema.json` (byte-identical / deep-equal parity). |
| **Red** | Schema `minLength: 1` accepts `"   "` and accepts bodies whose UTF-8 byte length > 60_000 when character length ≤ bound; dual copies can drift; parity tests too shallow. |
| **Green** | Both copies: nonblank pattern + `x-` (or equivalent) max UTF-8 byte metadata `60000` aligned with `COLLECTOR_REQUEST_BODY_MAX_BYTES`. Tests: deep equality file ↔ export; whitespace-only rejected by runtime (and schema pattern if validated); exact 60_000 multibyte OK; 60_001 rejected; packaged path still ships schema. |
| **Scope** | Schema/annotation + parity tests only. No runtime rule change beyond keeping single constant as source of annotation value. No Soul change. |

---

## Apply order (when approved)

1. **Evidence time (3)** — unblocks honest window relations before receipt assertions.  
2. **Receipt provenance (1) + inline ownership (5)** — same file, independent pure functions.  
3. **GitHub 2xx ambiguous (4)** then **signal thread (2)** — transport then role/ledger wire-up.  
4. **Schema parity (6)** — isolated contract surface.

## Verification (apply phase)

- Targeted: `test/collector-receipt.test.ts`, `test/collector-evidence` paths in ledger/receipt tests, `test/collector-github.test.ts`, `test/collector-ledger.test.ts`, `test/collector-config.test.ts` (and role cancel if covered).  
- Full gate: `npm run typecheck`; `npm test`; `npm pack --dry-run`; `git diff --check`.  
- Confirm no Soul diff; no disposed-root regressions (R5 null reuse, R11 observe cancel, R1 valid-precedence, R7 originalLine, etc.).  
- One new forward commit (no amend); title prefix per task contract; body maps each finding → owner fix or explicit non-adopt.

## Non-goals / refuse triggers

- Changing Collector Soul or adding scope/time/cancel “classifier” types.  
- Softening assertions or AC to go green.  
- Replacing cancel with rejected/ambiguous_loss.  
- New targetHead binding framework (ADR 0004 deferred); carried `commitOid` only.  
- If apply discovers packet/authority conflict or unsafe overlap with disposed roots → `refused` with evidence, no empty commit.
