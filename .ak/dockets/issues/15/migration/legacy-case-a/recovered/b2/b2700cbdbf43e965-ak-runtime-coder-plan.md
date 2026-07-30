## Baseline facts

- Branch `feature/deepen-role-runtime` is clean and exactly at the authorized baseline `05413b2e14b956e079eeb0bc20a1595fb562b3f6`; `BASE..HEAD` is empty.
- `src/role-runtime.ts` is 1,035 lines. It currently owns six flags, five tools, two narrowing calls, seven event hooks, 20 role/state variables, all three receipt schemas/validators, all prompt assembly, and all activation dispatch.
- Existing deep seams are real rather than adapters: `reviewer-execution-ledger.ts` (668 lines), `reviewer-agent.ts` (483), canonical binding, and the two auditors. History supports this direction: commit `6bb1eb6` extracted the Reviewer ledger and removed substantial runtime logic; `7bace16` extracted canonical binding. Wave 3 should repeat that replace-not-layer pattern.
- Current source consumers import the stable facade from `src/role-runtime.ts`; `extensions/role-runtime.ts` is the sole package adapter. Those paths and exports will remain.
- Baseline verification is green: typecheck passed; isolated-HOME test run passed 92/92 assertions; dry-run pack contains the current 14 package files and no `SKILL.md`; `git diff --check` and status are clean.
- CONTEXT and ADRs require role-local governance, demand-driven named roles, per-role named submission tools, no target binding/configuration/retry/orchestration, same-model audits, and exact Judge gating. No Soul or public-doc semantic change is warranted.

## Test-first sequence

1. **Strengthen characterization through the stable factory before moving code.** Extend the existing local harnesses rather than creating a new test framework:
   - In `test/judge-role.test.ts`, assert all six `registerFlag` calls in exact order with exact type/description bytes; no-role activation must load nothing, register no tools, narrow nothing, and leave input/prompt/events inert; unsupported roles must fail with the current diagnostic before any loader runs.
   - Assert exact system-prompt bytes for Judge, Fixer, and Coder, including trimming behavior, wrapper names, blank lines, phase/task/packet placement, and base prompt preservation. Keep the existing exact raw-byte Reviewer task test.
   - Characterize exact named tool registration order, labels, descriptions, snippets, guidelines, schemas, active-tool order, accepted text, details, usage passthrough, and `terminate: true`. Cover the full legal worker phase/status/`commitSha` matrix and malformed/unknown/blank values; retain the existing Judge verdict/note matrix and add missing Reviewer output combinations and singleton leaf shapes. Do not weaken existing assertions.
   - Add an explicit Reviewer chronology assertion around Skill capture, start/execute ledger observations, child result, bash evidence, output validation, audit, shutdown, and termination. Preserve revise as resubmittable and every fatal stage as sticky and aborting.
   - In `test/package-entrypoint.integration.test.ts`, compare the complete rendered extension-help block for all six flags and retain real-Pi tool/schema/termination checks. In `test/reviewer-package-lifecycle.test.ts`, update only the expected tarball source-file list after extraction and retain the independent install/lifecycle/no-`SKILL.md` proof.
   - Existing Coder strict canonical-TDD provenance/refusal tests, Reviewer Agent/ledger/audit/fatal tests, print/JSON nonzero subprocess tests, package lifecycle test, and Soul tests remain authoritative and unchanged in strength.

2. **Introduce focused red tests for the intended internal APIs.** Alongside the existing Judge/worker and Reviewer suites, directly construct each proposed role controller using the suite’s existing harness. Initially these imports fail because the modules do not exist. The focused tests prove that each controller—not the host—registers its own named tools/hooks, owns prompt contribution and state, and accepts only narrow dependencies. No reusable harness or alternate extension architecture will be added.

3. **Implement until both the focused tests and all stable-factory/package characterizations are green.** Preserve the red/green command output for the final report.

## Deep seams and exact cut

### `src/judge-role.ts`

Create a `createJudgeRoleRuntime(pi, dependencies, hostActions)` controller with one activation operation and private lifecycle state. It will own:

- `JudgeVerdict`, `SoulAuditInput`, `SoulAuditResult`, the TypeBox verdict schema, exact-key validation, and all three verdict/note shapes;
- Judge Soul loading/trimming/empty diagnostics;
- `ak_judge_output`, sole-final-call enforcement, audit input construction, revise behavior, usage passthrough, and accepted terminating receipt;
- the explicit ordered Judge whitelist and `<judge_soul>` prompt contribution.

Its dependency interface contains only Judge Soul loading, transcript serialization, compliance audit, and the shared fatal-action callback. Deleting this module would return schema, audit lifecycle, narrowing, and prompt logic to the host—not remove a forwarding wrapper.

### `src/worker-role.ts`

Keep the proven common mechanics and both explicit adapters in one substantial module, avoiding a shallow Fixer file:

- Private shared worker mechanics own `WorkerOutput`/aliases, the worker schema, exact-key/nonblank validation, plan/apply legality, planned/`commitSha` exclusion, sole-final-call proof, and thin terminating receipt construction.
- `createFixerRoleRuntime` explicitly owns `ak-fix-packet` and `ak-fixer-phase`, its exact help, Soul/packet loaders and trimming, Fixer diagnostics, named `ak_fixer_output` metadata/guidance, phase/packet prompt bytes, and unchanged construction-tool surface.
- `createCoderRoleRuntime` explicitly owns `ak-coder-task` and `ak-coder-phase`, its exact help, Soul/task loaders and trimming, named `ak_coder_output` metadata/guidance, and all Coder-only canonical TDD state: first-input transformation, pre-prefixed invocation behavior, immediate expansion capture, strict completion provenance, images, refusal path, and Coder prompt contribution.

There will be no role configuration table and no generic submission tool. The two explicit adapters share only mechanics proven identical today.

### `src/reviewer-role.ts`

Create a Reviewer controller with private task/binding/request/expansion/registration state and its own ledger instance. It will own:

- Reviewer and Agent schemas/validation/types and exact named tool definitions/order;
- raw task preservation, canonical `code-review` binding validation, first-input transformation and exact expansion capture;
- Agent persisted-evidence adaptation, start/execute/end reconciliation, child execution, result/usage adaptation, and diagnostic extraction;
- bash call/result hooks, audit-record creation, compliance audit/revise handling, sticky fatal adaptation, cleanup on acceptance and session shutdown;
- exact seven-tool narrowing and Reviewer prompt contribution.

It will continue delegating ledger invariants to `reviewer-execution-ledger.ts`, binding proof to `canonical-skill-binding.ts`, child execution to `reviewer-agent.ts`, and audit transport to `reviewer-auditor.ts`; none will be copied or merged.

### `src/role-runtime.ts` composition host

Reduce this file to:

- the stable `RoleRuntimeDependencies` shape and explicit source-compatible re-exports of every current constant/type, including Reviewer ledger receipt/audit types;
- exact `ak-role` registration plus ordered construction of the explicit Fixer, Coder, and Reviewer flag owners so help order is unchanged;
- active-role validation and an explicit four-way activation switch (not discovery, a registry, or a generic role table);
- the single truly shared Pi fatal-action adapter (`ctx.abort`, print/JSON exit code 1, rethrow) passed narrowly to consumers.

Role controllers register their own hooks during first successful activation and guard idempotent registration; the host does not forward every event or retain role state machines. `extensions/role-runtime.ts` remains the package-facing adapter and `createRoleRuntimeExtension(dependencies)` remains the only external factory.

Update internal auditor type imports to their owning deep modules to avoid facade cycles, while retaining explicit facade re-exports for existing source consumers.

## Structural/deletion audit

After implementation:

- Inspect `src/role-runtime.ts` and require no TypeBox schemas, `registerTool`, ledger/binding state, prompt XML construction, receipt validation, or role event state machines there.
- Confirm each role module contains its listed state and behavior; reject any seam that merely forwards flags/events/dependencies back to the host.
- Search for generic discovery/config files, role registries/tables, common output tools, routing, target binding, retries, CMR/model selection, and duplicated ledger/binding logic; all must be absent.
- Verify all current facade exports compile from `src/role-runtime.ts`, all named tool strings remain distinct, and Souls/README/CONTEXT/ADRs are byte-unchanged unless a genuinely stale internal path is found.

## Final gate and history discipline

Run the required gate exactly:

```bash
npm run typecheck
EMPTY_HOME=$(mktemp -d)
HOME="$EMPTY_HOME" npm test
npm pack --dry-run
git diff --check
```

Inspect dry-run contents for the three new deep modules, all existing package files, and no `SKILL.md`. Then make exactly one forward Coder commit (no amend/squash/push), rerun the gate at committed HEAD, and prove:

- `HEAD^` equals `05413b2e14b956e079eeb0bc20a1595fb562b3f6`;
- `git rev-list --count BASE..HEAD` is `1` and BASE is an ancestor;
- no merge/rewrite occurred and `git status --porcelain` is empty.

No files were edited and no commit was created while preparing this plan.
