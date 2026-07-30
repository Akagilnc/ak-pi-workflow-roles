# Fresh Reviewer receipt

## Standards

- **High — documented-standard violation.** `souls/collector.md:7` requires completion to bind to a “最终完整快照上的精确目标 HEAD”. When the first bracketing PR reads differ, `src/collector-ledger.ts:648-652` retries once but never verifies that the retry’s initial and terminal identities match. It then binds evidence fetched during that potentially drifting retry to only the terminal HEAD (`src/collector-ledger.ts:658-680`) and labels it complete. A sequence A→B, then C→D produces a torn “complete” D snapshot; target-scoped unavailable comments fetched under C can consequently support D.

- **Medium — documented-standard violation; also possible Duplicated Code smell (judgement call).** README calls `schemas/collector-legs-v1.schema.json` the machine-readable manifest schema (`README.md:157`), while CLAUDE assigns field semantics to schemas (`CLAUDE.md:9-14`). Yet the schema allows whitespace-only authors/bodies (`schemas/collector-legs-v1.schema.json:21-32`), while runtime rejects them, rejects duplicate authors, and imposes an absent 60,000-byte limit (`src/collector-config.ts:383-395,417-445`). Moreover, the schema is duplicated verbatim as `COLLECTOR_LEGS_SCHEMA` (`src/collector-config.ts:13-50`). Schema-valid caller input can therefore fail runtime, and two contract copies can drift.

Scratch checks after installing dependencies only in the review clone: typecheck passed; empty-HOME suite passed 196/196; pack dry-run contained the expected 26 files; diff-check passed.

## Spec

- **High — (c) implemented-looking but wrong:** repeated HEAD drift is accepted as an atomic complete snapshot. Controlling authority requires “atomic complete snapshots” (`/tmp/ak-collector-approved-synthesis.md:19`) and says “Current truth comes only from the latest complete snapshot” (`/tmp/ak-collector-v1-authority-v2.md:143`). Target code retries once when initial/terminal PR identities differ, but never verifies the retry is consistent (`src/collector-ledger.ts:646-652`); it then binds the second terminal HEAD and marks the mixed surfaces `complete: true` (`src/collector-ledger.ts:658-680,731-745`). The target test covers only one drift followed by stability (`test/collector-ledger.test.ts:634-656`). Scratch probe supplied HEAD reads A→B then C→D; `observe()` performed four reads yet returned `{"acceptedComplete":true,"targetHead":"D"}`. Thus reviews/comments fetched while HEAD was C can be certified as a complete D snapshot and drive an incorrect valid/missing receipt.

Summary: Standards — 2 findings, worst High (torn complete snapshot under repeated HEAD drift). Spec — 1 finding, worst High (repeated drift accepted as an atomic complete snapshot).
