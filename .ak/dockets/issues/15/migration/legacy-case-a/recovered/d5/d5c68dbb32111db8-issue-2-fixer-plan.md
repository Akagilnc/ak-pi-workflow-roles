Baseline verified: `HEAD` is exactly `9fe8618c8b2e44a2e11eadefe4e05b58d035eaaf`; worktree is clean. The three packet files were introduced at that commit and have no earlier repair history. No files were modified.

### P1 — `packets/fixer-repair.md`
- **Behavior:** Make an instantiated repair packet sealable without requiring it to embed a SHA-256 of its own exact bytes. State that the packet’s repository-relative path and exact-byte SHA-256 belong in the external contributor trail; keep in-packet path+digest entries only for separately sealed related authority, plan, or prior artifacts.
- **Owner:** `packets/fixer-repair.md`, specifically **Identity seal** and its identity/trail guidance.
- **Red:** The current adjacent blank fields `This packet path (repository-relative)` and `SHA-256 of exact bytes` require a self-referential digest whose insertion changes the bytes being digested, so the packet cannot be finally instantiated as claimed.
- **Green:** The identity table contains no self-path/self-digest fields; concise guidance explicitly assigns this packet’s path and exact-byte digest to the external trail, while related artifacts remain represented by path+SHA-256 fields.
- **Scope:** Preserve repair scope, R# reconciliation, forward-amendment, non-claims, and all runtime/public-contract statements; do not alter `docs/development-closure.md` or runtime.

### P2 — `packets/judge-plan.md`
- **Behavior:** Remove the duplicated Judge blocker/posture law while retaining packet-specific instructions to record all five readiness facts for every proposed change and to avoid fixture pseudocode or blanket `file:line` demands.
- **Owner:** `packets/judge-plan.md`, the introductory text under **Planned changes — five readiness facts**.
- **Red:** The sentence `Local Apply-decidable mechanics are Apply obligations, not invented plan blockers.` restates posture semantics despite the same template declaring `souls/judge.md` their sole owner.
- **Green:** That blocker-law sentence is absent; Behavior, Owner, Red, Green, and Scope remain present, and the per-change filling/reconciliation guidance remains clear.
- **Scope:** Do not edit `souls/judge.md`, alter the five fields, or change routing/non-claim semantics; no runtime changes.

### P3 — `packets/judge-apply.md`
- **Behavior:** Define identities by artifact meaning rather than an unspecified range convention: target commit is the complete snapshot under claim; range base is the base snapshot from which the reviewed delta starts; range target is the target snapshot at which that delta ends; the base+target pair identifies only the reviewed delta.
- **Owner:** `packets/judge-apply.md`, **Target and range identity** table and its immediately following distinctions.
- **Red:** `Inclusive-exclusive base of reviewed delta` mixes endpoint terminology, leaving base membership ambiguous and potentially implying an incorrect convention.
- **Green:** No inclusive/exclusive wording remains; each SHA’s snapshot role and the pair’s delta meaning are explicit without prescribing commit-set endpoint membership or range syntax.
- **Scope:** Preserve upstream artifact seals, construction/seam/boundary evidence, guardrail triad, and explicit non-claims; do not define Git range syntax or touch runtime.

Apply verification should be a focused diff plus text searches confirming removal of the self-digest fields, blocker-law sentence, and `Inclusive-exclusive`, followed by repository-declared Markdown/document checks if present. Only the three named packet documents are authorized.
