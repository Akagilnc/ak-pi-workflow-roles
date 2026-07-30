# Issue 15 Case-A repair-003 — final fixed-target findings

Authority: accepted Review-posture Judge Receipt at `.ak/dockets/issues/15/review/final-fixed-target/judge/receipt.json`.

Immutable prior targets: `ea64733e382c6dcf14906b3b52782ec3f1c07535`, `702e36f97caa92f012470bf5a890e656a5859800`, `49807d493861b5dc5e9c6a9813b2d7679a241df8`, and `da250445d09ef2b9105a99590f2ccda0a8db29c4`.

## Exact repair set

R1: In the existing `test/legacy-case-a-migration-verifier.test.ts` only, replace the basename allowlist as the post-cutoff classification oracle with the sealed cutoff rule and exact candidate identity evidence. Add a red case where a pre-cutoff omitted candidate is named `coder.ts` and prove that the same oracle rejects it. Keep this as the only regression verifier.

R2: In that same verifier, deterministically derive the exact issue/PR/commit association set from frozen metadata and every admitted non-generic byte, including referenced bytes, Markdown/text, and nested JSON. Update migration association metadata to the derived exact set. Mutate a second item’s actual parsed association field/input and run it through the same exact-set comparison to prove failure; deleting only an expected-map entry is insufficient. Do not inspect generic JSONL/session/tool-event payloads.

R3: Append one new Recorder successor without changing repair-002’s manifest, implementation, result, or any other historical evidence. Preserve an independently executable child that reruns corrected R1 and actual `scanBytes` R2. It must load disposition selection and reports from immutable Git inputs, verify exact scanner-module bytes before execution, and emit a complete identity ledger: repository/full commit/path/blob OID/SHA-256 for Git-resolvable discovery spec, walk, inventory, dispositions, reports, scanner and other repository inputs; sealed item key/source SHA-256/applicable frozen metadata for genuinely external source bytes. Do not retain raw source duplicates. Recorder child must exit 0 only on 597 matched/0 missing/0 changed, cutoff-derived all-and-only partition, exactly 277 selected sources, all source/derivative hashes and complete hit reports matching, and both redactions present.

R4: At the new target, pass `npm run typecheck` and `node --import tsx --test test/legacy-case-a-migration-verifier.test.ts`; mechanically verify every new ledger tuple/seal and the corrected association exact set/red mutations. Reverify without modifying the four historical Receipt/manifest identities in `historical-nonconformance.json` and repair-002 implementation/result seals `fd219ea9…` and `654fdff4…`. Preserve all prior migration, repair, Receipt, manifest, exhibit, result, and historical-nonconformance bytes.

## Plan readiness and limits

For each R key, the Plan must state Behavior, deepest Owner, Red, Green, and Scope. Reconcile by exact key set only: `{R1,R2,R3,R4}`, each key exactly once, each keyed disposition nonblank. Headings and their spelling are not conformance requirements.

If any of the 597 historical identities or 277 required external source identities is missing or changed, return evidence-bearing `refused`; do not substitute a new cutoff or denominator.

Out of scope: Case B, issue #16, issue #17, history rewrite, session retention, generic payload, excluded-payload inspection, raw-source duplication, a parallel verifier/helper, Soul/runtime/schema changes, and mutation of prior evidence.
