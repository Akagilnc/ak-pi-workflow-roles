# Fix plan — issue #3 residuals on 0546c8b

## Baseline
- HEAD: `0546c8b` (clean).
- Prior same-seam work:
  - `5933d20` hardened `isError===false` + non-empty `toolCallId` merge, but still trusts orphan terminals and `Map.set` overwrite.
  - `0546c8b` only fixed meta provider/model provenance.
- Do **not** re-ship weak terminal-name/id-only acceptance, hand-edited JSONL soul pins, or Soul kernel deletion.

## Out of scope
- No runtime status/routing/behavior changes (`src/judge-role.ts` execute path, phases, tools whitelist).
- No issue #1/#2 work.
- No new verdict statuses or caller routing.

---

## Finding 1 — JSONL acceptance oracle bind

### Behavior
Accepted `ak_judge_output` must be a completed call chain, not a self-asserted terminal row:
1. completed assistant `message_end` issues `toolCall` name=`ak_judge_output`, non-empty `id`, object `arguments`;
2. matching `tool_execution_start` same non-empty `toolCallId`/`toolName` and args deep-equal to issued arguments;
3. terminal success (`tool_execution_end` and/or `toolResult` message/`message_end`) with `isError===false`, acceptance text, object `details`;
4. `details` deep-equal issued arguments (and therefore start args);
5. all terminal representations for one id **agree** (deep-equal payload); disagreement rejects the id (no overwrite).

### Owner
`test/judge-posture-recordings.test.ts` → `extractAcceptedJudgeOutputs()` (test-local oracle only).

### Red
- Standalone accepted `tool_execution_end` / `toolResult` (no assistant call + start) → `accepted.length === 0` (today: 1).
- Same-id terminals with conflicting details (e.g. earlier `continue`, later `converged`) → 0 (today: 1 via overwrite).
- Keep existing missing-`isError` red.

### Green
- Both real bundles `r-block` / `r-ready` still yield exactly one bound accepted output; receipt/meta/direction checks unchanged.
- Update merge probe to full chain (assistant call → start → end → message_end-result) with agreeing payloads → still 1.
- Two distinct fully-bound ids with identical details → still 2 (no collapse).

### Scope
- Only oracle + its synthetic probes in `test/judge-posture-recordings.test.ts`.
- Update fixture README offline-CI bullet to describe bind + duplicate-agreement (docs of oracle, not new mechanism).
- Implementation sketch:
  - index issued calls from completed assistant `message_end` only;
  - index starts from `tool_execution_start`;
  - collect terminal candidates by id; reject on missing bind, args mismatch, or terminal disagreement;
  - use structural deep equality (e.g. `util.isDeepStrictEqual`), not last-write-wins `Map.set`.

---

## Finding 2 — CLAUDE Soul layering audit (keep judgment kernel)

### Behavior
Complete Soul content layering without deleting irreducible professional judgment.

**Retain (judgment kernel):**
- material-relative Authority / Plan / Apply / Review burdens;
- Plan five facts (Behavior/Owner/Red/Green/Scope);
- complete-first / late-finding / authority-freeze chronology;
- local-mechanics-vs-Plan-blocker judgment (Apply-decidable detail is not a plan gate);
- strict production-evidence Apply review;
- Review finding adjudication (no reviewer rewrite/routing);
- material-relative meanings of converge / actionable continue / owner escalate;
- evidence discipline, repair triad, surface-audit, deadlock escalate.

**Trim from `souls/judge.md` only (non-Soul carriers):**
- flags / call-history / topology catalog → short materials-only inference principle;
- Authority/Apply fixture, byte/time, `Pi/包`, commit/diff example lists → generic executable-proof / production-seam principles;
- `note` field instruction (plan section + 判词 paragraph);
- verdict field catalogs/combinations;
- infrastructure non-zero Action / error-handling mechanics.

**Transport owners (no new behavior):**
- `judgeStatus` / optional `note` remain in registered tool schema (`src/judge-role.ts` Typebox; optional description-only if needed) and README Verdict contract;
- dedupe README: Judge overview currently restates plan-converged + note; keep one overview sentence + single Verdict-contract home for note/status semantics.

### Owner
- Judgment text: `souls/judge.md`
- Principle guards: `test/judge-soul.test.ts`
- Transport copy: `README.md` (+ schema descriptions only if necessary)
- Provenance: both posture bundles after final Soul bytes

### Red / Green (soul tests)
Rewrite guards to protect principles, not carriers:
- **Stop requiring:** flags/topology token presence, `note`, verdict-schema field tokens, infrastructure/non-zero-exit mechanics.
- **Require:** materials-only burden inference; four postures; five facts; plan-only construction authorization; local-mechanics ≠ plan blocker; complete-first/freeze; Apply production-evidence strictness; Review adjudicative boundary; evidence/repair/surface/deadlock kernel; three material-relative judgment labels without field catalogs.
- Extend denylist for trimmed carriers (`note` field instruction, 非零退出/Action mechanics, fixture/Pi/byte catalogs) where that does not fight retained principles.

### Scope
- `souls/judge.md`, `test/judge-soul.test.ts`, `README.md` (dedupe only).
- After final Soul text: **re-record both** `r-block` and `r-ready` via fixture README opaque procedure (live Judge run); refresh `session.jsonl`, `receipt.json`, `meta.json` (`soulDigest`, provider/model from JSONL). **No hand-edit** of session soul bytes.
- Optional: fixture README offline rule text only.

---

## Apply order
1. Harden oracle + red/green probes; confirm synthetic reds fail on current extractor then pass.
2. Trim Soul; update soul tests + README dedupe.
3. Re-record both opaque bundles; pin digests.
4. Verify: targeted posture + soul tests, full `npm test`, `npm run typecheck`, `git diff --check`.
5. Single forward commit (no amend); title prefix per task contract, e.g. `fix(judge): ...`.

## Risks / notes
- Re-record needs live model/credentials and opaque export workspace; flake on direction → re-run, do not coach inputs.
- Schema/runtime execute path stays behavior-identical; descriptions-only if touched.
- Deleting the judgment kernel or relaxing bundle AC is refusal-worthy, not a fix.
