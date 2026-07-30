Reviewed immutable range `c04d24e19390cab239b8c7e31c7ccb9a8975ad18...8357f6d59f3da4572ef33847645745abfec63571` against `/tmp/issue-2-authority.md` and `/tmp/issue-2-coder-plan.md`.

## Standards

### Hard violation

- **`docs/development-closure.md:10,23,46-47` — canonical Receipt terminology.** The phrases **“Verdicts live in receipts and the development trail”** and **“judgment receipt/trail entry”** make an untyped trail entry sound interchangeable with a role Receipt. `CONTEXT.md:8` defines Receipt as the typed submission-tool product and the role’s sole lawful output; `README.md:11-13,44` likewise permits a final Judge verdict only through `ak_judge_output`. A trail may preserve a Receipt, but cannot substitute for one.

### Judgement-call smells

- **Duplicated Code / Shotgun Surgery — all five `packets/*.md` files, especially their opening and “Explicit non-claims” hunks.** Variants of **“The filename identifies an evidence burden, not a verdict…”**, **“Selection, composition, and use are caller-owned”**, and **“Filename is not a verdict…”** are repeated across every template and again in `docs/development-closure.md:53-54`. Changes to this shared packet policy would require synchronized edits across six files. A shared packet-conventions document with concise references would centralize the invariant.

No probes or scratch artifacts were created by the Standards leg; observations are from the immutable target.

## Spec

**(a) Missing or partial requirements:** None.  
**(b) Unasked behavior or scope creep:** None.  
**(c) Present-looking but incorrect implementation:** None.

The pinned range changes exactly the seven authorized paths. `package.json` is unchanged, and its 26-entry packlist excludes `packets/`, `docs/`, and `CLAUDE.md`. A non-mutating `npm pack --dry-run --json` probe confirmed this and left no scratch artifacts or working-tree changes. Independent verification also passed all 259 tests and `npm run typecheck`.

**Summary:** Standards: 2 findings (worst: hard Receipt/trail terminology violation). Spec: 0 findings (no worst issue).
