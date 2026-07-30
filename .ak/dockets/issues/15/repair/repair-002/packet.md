# Issue 15 Case-A final evidence repair

Preserve immutable migration `ea64733e…`, repair target `702e36f…`, and all historical Receipt/manifest bytes. Governing judgment: `.ak/dockets/issues/15/review/post-repair/judge/receipt.json`.

| R# | Requirement |
| --- | --- |
| R1 | Close fixed-target oracle with immutable-Git sealed spec/walk/inventory, failing any omitted/changed historical identity, predicate drift, or post-cutoff partition error. Preserve exact independently executable corroboration implementation and result in a new Recorder successor invocation; stop/refuse if any required source changed. |
| R2 | In that successor invocation run actual `scanBytes` over all 277 matched original non-generic sources and compare source hash, produced derivative hash, and full hit report including `42a9fc…`/`af289a…`; store only implementation/result, no source duplicates; stop/refuse on source change. |
| R3 | Make existing association verifier exhaustive for all associations derivable from frozen metadata/admitted non-generic bytes, with a second-item red mutation; in same file introduce one local association type, rename opaque PR5 locals, remove unused `gitIsAncestor` head parameter. No split/index/generic JSONL reads. |
| R4 | Add append-only nonconformance/successor closure record sealing original and nonconforming successor Receipt/manifest Git identities exactly as Judge states; bind new R1-R3 proof; never mutate those paths again and treat manual reconciliation as exact-set only. |

Plan/Apply response: exact two-column Markdown table with R1..R4 once each, no other R-like key, each `implemented(<test/evidence>)` or `refused(<reason>)`. No Case B/#16/#17/history rewrite/session payload/generic payload/parallel verifier.
