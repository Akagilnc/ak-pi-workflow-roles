Reviewed fixed diff `c721b940269a86b60a093223c812ade2218109e4...0546c8bdbadfa4f27c2ea2fafa9b9ae4cde9e372`. The merge-base and non-empty diff were confirmed; authority and plan hashes matched the supplied SHA-256 values.

## Standards

### Hard violations

- **Soul process/task pollution:** `souls/judge.md:15-16,47-55,67-68` embeds invocation history, review sequencing, authority-freeze workflow, and Reviewer routing. Lines `24,59-62` add host-specific fixture, Pi/package seam, commit/diff, and lifecycle instructions. `CLAUDE.md` assigns stage/process and repository/task conventions to Skill/host overlay, not bundled Soul.
- **Schema/runtime pollution:** `souls/judge.md:44-45,83,89-95` specifies `note`, verdict names, status-specific fields, and combinations already owned by `src/judge-role.ts`; lines `98-99` prescribe non-zero Action termination, a runtime invariant. This conflicts with `CLAUDE.md`’s ownership rules.
- **Failure to delete/compress:** Plan-convergence semantics are repeated at `souls/judge.md:36-37,85-88` and `README.md:17,177`; Apply obligations via `note` recur at `souls/judge.md:44-45,92-95` and `README.md:17,181`. `CLAUDE.md` requires keeping duplicated rules at their deepest owner and defaulting to deletion/compression.
- **Tests enshrine the pollution:** `test/judge-soul.test.ts:16,36,44-48,54,61-64` requires flags/history/topology, cross-call process, routing, schema tokens, and infrastructure mechanics to remain in Soul, defeating the mandated Soul-pollution audit.

### Labelled judgement calls

- **Repeated Switches:** `test/judge-posture-recordings.test.ts:84-358` repeatedly cascades over `record.type`, `message.role`, and `toolName`; one typed JSONL event index/parser could own this logic.
- **Duplicated Code:** Lines `307-335` duplicate tool-result extraction for `message` and `message_end`.
- **Shotgun Surgery:** `test/fixtures/judge-postures/README.md:52,59-60` requires every Soul edit to rewrite both large recordings and metadata, scattering one logical change across fixture files.

## Spec

- **High — Recorded-probe trust root does not enforce exact tool-call identity.** Approved-plan Cluster G requires the JSONL-derived sole successful `ak_judge_output`, explicit success, exact terminal identity, and anti-forgery validation. `extractAcceptedJudgeOutputs()` accepts any standalone `tool_execution_end` or `toolResult` that claims the tool name, marker, `isError:false`, and arbitrary ID/details, without requiring a matching assistant `toolCall` and `tool_execution_start`; duplicate representations sharing an ID overwrite one another without equality checks (`test/judge-posture-recordings.test.ts:260-338`). Bundle validation only requires one resulting map entry (`:509-522`), while the negative cases do not cover a forged standalone accepted end (`:550-615`). Thus the checked-in recordings are internally coherent, but CI does not prove that the accepted result belongs to the exact model-issued/audited call required by the plan.

No additional missing requirement or scope-creep finding was reported on the Spec axis.

Verification on the reviewed target: `npm test` passed 249 tests, `npm run typecheck` passed, the requested targeted suite passed 63 tests, and `git diff --check` passed.

**Summary:** Standards — 7 findings (4 hard, 3 heuristic), worst: bundled Soul layering/schema-runtime pollution. Spec — 1 finding, worst: the JSONL oracle can accept an unbound forged terminal result.
