- **P1 — `targetHead` binding is entirely absent.**  
  **Evidence:** `src/role-runtime.ts:11-31` defines no `targetHead`; `src/role-runtime.ts:102-157` rejects every extra key; no code reads `AK_JUDGE_TARGET_HEAD`.  
  **Requirement:** “Judge receipt supports optional `targetHead`; when `AK_JUDGE_TARGET_HEAD` is bound, submission fail-closed checks equality before Soul audit.”  
  **Consequence:** Standalone submissions cannot include the documented optional field, while bound callers receive no protection against judging the wrong commit.  
  **Repair:** Add optional `targetHead` to all verdict shapes, read the environment binding, and reject absent/mismatched values before calling `auditSoulCompliance`.

- **P1 — Bundled Judge Soul remains host-specific rather than generic.**  
  **Evidence:** `souls/judge.md:14-22,27-38,43-48,57-63` requires container-global law, ticket/ADR identifiers, `stationReceiptContracts`, family routing, `blocked_by`, and a ledger.  
  **Requirements:** “Soul uses generic package law with per-invocation host overlay” and Judge “adjudicates ordinary Markdown review material without requiring a new upstream finding format.”  
  **Consequence:** An independent installation lacks these host institutions and may reject or mishandle ordinary Markdown reviews unless callers reproduce an undocumented legacy workflow format.  
  **Repair:** Rewrite the bundled Soul to the generic principles enumerated in ADR 0005; leave host-specific rules to native per-invocation overlays.

- **P1 — Judge tool narrowing was not implemented.**  
  **Evidence:** `src/role-runtime.ts:222-321` activates the role and registers its output tool but never calls `setActiveTools`; `README.md:10` misleadingly promises “normal tools.”  
  **Requirement:** “Judge role mechanically narrows active tools to evidence-gathering tools and removes write/edit.”  
  **Consequence:** An independently installed Judge retains write/edit capabilities despite the documented mechanical role gate.  
  **Repair:** On Judge activation, call `setActiveTools` with the approved evidence-gathering allowlist, excluding write/edit; document that this is not a security boundary.

- **P1 — Temporary audit failures are recoverable tool errors, not non-zero Action failures.**  
  **Evidence:** authentication/provider failures throw inside tool execution (`src/soul-auditor.ts:43-62,159-168`; `src/role-runtime.ts:295-318`). The package’s integration behavior treats thrown submission errors as ordinary `toolResult` errors and continues prompting (`test/package-entrypoint.integration.test.ts:175-193`).  
  **Requirement:** “Temporary provider/toolchain failure is a non-zero Action failure.”  
  **Consequence:** The model can continue or resubmit after infrastructure failure, and the invoking Action may exit successfully without an authoritative receipt.  
  **Repair:** Route audit/toolchain infrastructure failures through a fatal session/CLI failure mechanism while keeping Soul `revise` recoverable.

- **P2 — Committed authority contradicts the ratified Fixer contract.**  
  **Evidence:** `CONTEXT.md:10` says Fixer has “无交卷工具,” while `README.md:52-58` and runtime expose `ak_fixer_output`.  
  **Requirement:** “Fixer submits through `ak_fixer_output`.”  
  **Consequence:** Installed-package documentation gives incompatible definitions of the authoritative Fixer receipt.  
  **Repair:** Update CONTEXT (and superseded ADR 0003 wording) to describe the thin Fixer envelope and Git commit as separate objective evidence.
