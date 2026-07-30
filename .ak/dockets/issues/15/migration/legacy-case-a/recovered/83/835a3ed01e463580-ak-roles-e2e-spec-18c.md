- **P1 — Judge Soul remains host-specific, not generic package law.**  
  **Evidence:** `souls/judge.md:14-22,27-45,57-58` references container-global law, ticket/ADR numbers, `family`, `stationReceiptContracts`, `blocked_by`, and legacy `verify` routing. This contradicts `docs/adr/0005-...md:6`.  
  **Requirement:** “Soul uses generic package law with per-invocation host overlay rather than embedding business-specific law.”  
  **Consequence:** Standalone users receive rules and dependencies unavailable outside the originating host, making adjudication misleading or impossible.  
  **Repair:** Replace the bundled Judge Soul with the generic law described by ADR 0005; leave host terminology/routing to `--append-system-prompt` or project skills.

- **P1 — `targetHead` binding contract is entirely absent.**  
  **Evidence:** `src/role-runtime.ts:11-31,51-57,118-174` defines and validates receipts without `targetHead`; no code reads `AK_JUDGE_TARGET_HEAD`. This contradicts `docs/adr/0004-...md:6`.  
  **Requirement:** “Judge receipt supports optional targetHead; when AK_JUDGE_TARGET_HEAD is bound, submission fail-closed checks equality before Soul audit.”  
  **Consequence:** A bound caller cannot prove the verdict covers its intended commit, and stale/wrong-head receipts proceed to audit and acceptance.  
  **Repair:** Add optional `targetHead` to every verdict shape and validate exact equality with the environment binding before invoking the auditor.

- **P1 — Judge tool narrowing is not implemented and README promises the opposite.**  
  **Evidence:** `src/role-runtime.ts:244-356` never calls `setActiveTools`; `README.md:10` says Judge uses “normal tools.” This contradicts `docs/adr/0008-...md:6`.  
  **Requirement:** “Judge role mechanically narrows active tools to evidence-gathering tools and removes write/edit.”  
  **Consequence:** An independently installed Judge exposes write/edit despite the documented role gate.  
  **Repair:** On Judge activation, allow only read/grep/find/ls/bash plus `ak_judge_output`; document that narrowing and its non-security-boundary status.

- **P1 — Audit infrastructure failures are ordinary recoverable tool errors, not fatal Action failures.**  
  **Evidence:** `src/role-runtime.ts:329-352` lets auditor exceptions escape from tool execution; Pi converts tool exceptions into tool-result errors and continues the agent turn, as exercised for tool failures in `test/package-entrypoint.integration.test.ts:135-159`.  
  **Requirement:** “Temporary provider/toolchain failure is a non-zero Action failure.”  
  **Consequence:** The model can continue to plain text or another turn and the CLI may exit successfully without an authoritative receipt.  
  **Repair:** Distinguish `revise` from infrastructure errors and terminate/fail the non-interactive session with a non-zero exit on the latter.

- **P2 — Fixer does not enforce its single-envelope contract.**  
  **Evidence:** `src/role-runtime.ts:297-310` accepts output without checking the persisted assistant batch, unlike Judge’s singleton check at `176-196,333`.  
  **Requirement:** “Fixer submits one thin envelope through `ak_fixer_output`.”  
  **Consequence:** Parallel Fixer output calls can both be accepted, yielding ambiguous receipts.  
  **Repair:** Require `ak_fixer_output` to be the sole final tool call before validation.
