## Current Spec findings

- **High — Verdict contract still accepts invalid mixed shapes.** `fix` and `decisionGate` remain independently optional (`src/role-runtime.ts:10-30`); execution only checks required presence for `continue`/`escalate` (`src/role-runtime.ts:103-114`). Thus `converged + fix`, `continue + decisionGate`, and `escalate + fix` are accepted, contrary to the exact three-state output contract.

- **High — Soul audit still fails open on contradictory/malformed decisions.** The parser selects the first matching call rather than requiring exactly one (`src/soul-auditor.ts:49-55`) and accepts every `pass` regardless of missing/non-array/non-empty `violations` or extra arguments (`src/soul-auditor.ts:57-68`). This can approve a pass-with-violations or pass followed by revise despite the “exactly once” instruction at line 101.

- **High — Successful verdict submission still is not guaranteed final.** The implementation relies on a prompt guideline (`src/role-runtime.ts:95-97`) and `terminate: true` (`src/role-runtime.ts:128-133`). It does not prevent sibling tool calls; Pi only terminates a parallel batch when all results terminate. Consequently, an audited passing verdict can coexist with another call and the agent loop can continue.

- **High — Bundled judge Soul still requires upstream-specific formats and unavailable workflow infrastructure.** It mandates ADR/ticket authority sets (`souls/judge.md:17-22`), issue creation and native `blocked_by` (`:27-33`), typed dispatch schemas and `stationReceiptContracts` (`:35-38`), and named ADRs/workflow concepts (`:40-49`). This violates the requirement not to require upstream adoption of a report/finding format.

- **Medium — Escalation still permits semantically empty gates.** `minLength: 1` permits whitespace-only questions/options (`src/role-runtime.ts:22-23`), while runtime merely checks that `decisionGate` exists (`:109-114`).

- **Medium — Fixer Soul adds constraints beyond the stated FixerAction contract instead of allowing free repair/testing.** It mandates reading issue/authority pointers, inspecting per-file Git history, and using a named skill (`souls/fixer.md:9-14`), prescribes solution strategy (`:18-23`), and requires fixer-side mechanical ancestry validation (`:34`) even though the caller owns that Git gate. These are scope-creep restrictions unrelated to consuming `fix.summary`, repairing/testing, and producing a non-amended forward commit.
