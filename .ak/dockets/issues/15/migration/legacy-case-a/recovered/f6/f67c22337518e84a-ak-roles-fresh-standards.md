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
