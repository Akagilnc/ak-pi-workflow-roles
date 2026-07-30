# Fresh code review for HEAD c7eaeda

## Standards axis

## Current live Standards findings — HEAD `c7eaeda` (clean)

- **P1 — Soul audit still accepts malformed or contradictory “pass” responses.**  
  `src/soul-auditor.ts:49-67` selects only the first matching tool call and returns pass without requiring `violations` to be an empty array, rejecting extra arguments, or detecting multiple/contradictory calls. Since constrained sampling is only `"prefer"` (`:43-46`), provider-side schema enforcement is not guaranteed. This can accept an unaudited verdict despite README’s compliance-before-acceptance claim (`README.md:11-15`).

- **P1 — Valid unauthenticated providers still cannot run the auditor.**  
  `src/soul-auditor.ts:84-92` rejects `{ok:true}` unless `apiKey` is truthy. Pi permits local/custom providers with no API key; `ProviderStreamOptions.apiKey` is optional. Such models can run the judge but can never produce an accepted verdict.

- **P1 — A successful verdict is not guaranteed to terminate the judge run.**  
  `src/role-runtime.ts:95-96,128-132` relies on an instruction plus `terminate: true`. Pi treats termination as a batch-level hint: a sibling non-terminating tool call prevents early termination. The extension neither blocks sibling calls nor verifies that `ak_judge_output` is the sole/final call, contradicting `README.md:13,40`.

- **P2 — Verdict states remain invalidly representable (Fowler flag-argument/data-clump smell).**  
  The schema independently makes `fix` and `decisionGate` optional (`src/role-runtime.ts:10-30`); runtime checks only missing fields for two statuses (`:103-114`). It accepts `converged + fix`, `continue + decisionGate`, `escalate + fix`, and whitespace-only gate questions/options. This is not the exact three-shape contract documented at `README.md:52-56`.

- **P2 — Fixer correctness is entirely prompt-enforced and depends on an unbundled skill.**  
  Runtime merely injects the fixer Soul (`src/role-runtime.ts:138-145`); it captures neither starting HEAD nor commit outcome. The Soul requires `diagnosing-bugs` (`souls/fixer.md:13-14`), but `package.json:12-14` packages only the extension and no skill. Although README correctly assigns the descendant gate to the caller (`README.md:50`), the package itself cannot ensure the promised checks/commit behavior or availability of its prescribed diagnostic path.

- **P2 — Tests still mock away the critical Pi and Git boundaries.**  
  `test/judge-role.test.ts:12-36` uses `any` and a partial fake API; it never loads `extensions/role-runtime.ts`, exercises Pi schema validation/parallel termination, unsupported roles, malformed cross-status verdicts, fixer refusal, or forward-commit behavior. `test/soul-auditor.test.ts:56-96` omits malformed/multiple pass and keyless-auth cases. All eight tests and typecheck pass, but they do not protect the highest-risk contracts.


## Spec axis

## Current Spec findings

- **High — Verdict contract still accepts invalid mixed shapes.** `fix` and `decisionGate` remain independently optional (`src/role-runtime.ts:10-30`); execution only checks required presence for `continue`/`escalate` (`src/role-runtime.ts:103-114`). Thus `converged + fix`, `continue + decisionGate`, and `escalate + fix` are accepted, contrary to the exact three-state output contract.

- **High — Soul audit still fails open on contradictory/malformed decisions.** The parser selects the first matching call rather than requiring exactly one (`src/soul-auditor.ts:49-55`) and accepts every `pass` regardless of missing/non-array/non-empty `violations` or extra arguments (`src/soul-auditor.ts:57-68`). This can approve a pass-with-violations or pass followed by revise despite the “exactly once” instruction at line 101.

- **High — Successful verdict submission still is not guaranteed final.** The implementation relies on a prompt guideline (`src/role-runtime.ts:95-97`) and `terminate: true` (`src/role-runtime.ts:128-133`). It does not prevent sibling tool calls; Pi only terminates a parallel batch when all results terminate. Consequently, an audited passing verdict can coexist with another call and the agent loop can continue.

- **High — Bundled judge Soul still requires upstream-specific formats and unavailable workflow infrastructure.** It mandates ADR/ticket authority sets (`souls/judge.md:17-22`), issue creation and native `blocked_by` (`:27-33`), typed dispatch schemas and `stationReceiptContracts` (`:35-38`), and named ADRs/workflow concepts (`:40-49`). This violates the requirement not to require upstream adoption of a report/finding format.

- **Medium — Escalation still permits semantically empty gates.** `minLength: 1` permits whitespace-only questions/options (`src/role-runtime.ts:22-23`), while runtime merely checks that `decisionGate` exists (`:109-114`).

- **Medium — Fixer Soul adds constraints beyond the stated FixerAction contract instead of allowing free repair/testing.** It mandates reading issue/authority pointers, inspecting per-file Git history, and using a named skill (`souls/fixer.md:9-14`), prescribes solution strategy (`:18-23`), and requires fixer-side mechanical ancestry validation (`:34`) even though the caller owns that Git gate. These are scope-creep restrictions unrelated to consuming `fix.summary`, repairing/testing, and producing a non-amended forward commit.
