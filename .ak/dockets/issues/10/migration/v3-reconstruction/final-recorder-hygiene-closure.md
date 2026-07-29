# Final Recorder hygiene closure evidence

Append-only closure record for generated-artifact hygiene and final gates on
`feature/durable-invocation-dockets-v3`. Does not rewrite
`final-recorder-reconstruction.md`, migration inventories, historical
Receipts/manifests, or the missing-Coder disposition.

## Baseline

| Fact | Value |
| --- | --- |
| Starting HEAD (apply tip) | `ce940dcdb97dba0475d8632a874db88750b41a33` |
| Plan-referenced ancestor | `a5374fcdcc412997305cc53414a6ecc0f6845b7b` |
| Recorded default SHA | `6e76efa93588844996611b86320de7747cca3d24` |
| Branch | `feature/durable-invocation-dockets-v3` |

### Final HEAD identity (no self-seal)

Final HEAD is the commit that introduces this file. Resolve after commit:

```bash
git log -1 --format=%H -- \
  .ak/dockets/issues/10/migration/v3-reconstruction/final-recorder-hygiene-closure.md
```

The applying Receipt states the resulting exact SHA. Git cannot embed a commit’s
own SHA in bytes belonging to that same commit under single-forward-commit/no-amend.

## Hygiene fix (owner path)

Trailing blank in generated `dist/recorder/errors.js` (`constructor(code, `)
came from a multiline `RecorderError` constructor parameter list with an inline
parameter JSDoc in `src/recorder/errors.ts`. Fix: move the note to a constructor
JSDoc `@param message` and regenerate via `npm run build:recorder`.

```bash
grep -nE '[[:blank:]]+$' dist/recorder/errors.js
# no output (exit 1 / non-match) after regeneration
```

No runtime behavior or public contract change. Authorized paths only:
`src/recorder/errors.ts`, `dist/recorder/errors.js`, and this evidence file.

## Gates (observed before evidence commit)

| Gate | Result |
| --- | --- |
| `npm install` | exit 0 |
| `npm run build:recorder` | exit 0 |
| `grep -nE '[[:blank:]]+$' dist/recorder/errors.js` | no match |
| `npm run typecheck` | exit 0 |
| focused Recorder tests (5 files) | 43/43 pass, exit 0 |
| `npm test` | 310/310 pass, exit 0 |
| `npm pack --dry-run --json` | 58 files; filename `ak-pi-workflow-roles-0.1.0.tgz` |
| clean tarball install inventory | 58 files (matches dry-run) |
| installed `node_modules/.bin/ak-docket-record` (no argv) | exit 125; public `invalid-argv` JSON |
| worktree `git diff --check` | exit 0 |
| index `git diff --check` (while preparing) | exit 0 |

Focused command:

```bash
node --import tsx --test \
  test/recorder-admission.test.ts \
  test/recorder-cli.test.ts \
  test/recorder-extract-scan.test.ts \
  test/recorder-package-lifecycle.test.ts \
  test/recorder-transaction.test.ts
# 43/43 pass
```

### Production-range `git diff --check`

```bash
git diff --check 6e76efa93588844996611b86320de7747cca3d24..HEAD
```

- At starting HEAD (before hygiene fix): exit 2 on
  - `dist/recorder/errors.js:20` trailing whitespace (fixed by this commit)
  - `.ak/dockets/issues/10/authority/materials.md:46` new blank line at EOF
- After hygiene fix (pre-evidence tree probe): exit 2 **only** on sealed
  `materials.md:46` new blank line at EOF
- `materials.md` is retained inventory item
  (`blobOid` `6d261cd1267481021668db5fae952e9769321030`, 3544 bytes) and is
  **out of scope** to edit; changing it would break retained-seal equality
- Worktree/index checks for this commit’s diff: exit 0

## Exact tracked logical-byte totals

At starting HEAD `ce940dcdb97dba0475d8632a874db88750b41a33`:

```bash
git ls-tree -r -l HEAD | awk '{sum+=$4} END {print sum}'
# 10041111

git ls-tree -r -l HEAD .ak/dockets/issues/10 | awk '{sum+=$4} END {print sum}'
# 321247
```

Worktree size deltas for code paths before this commit:
- `src/recorder/errors.ts`: 3093 → 3106 (+13)
- `dist/recorder/errors.js`: 2139 → 2149 (+10)

After this evidence commit, recompute (Receipt records observed finals):

```bash
git ls-tree -r -l HEAD | awk '{sum+=$4} END {print sum}'
git ls-tree -r -l HEAD .ak/dockets/issues/10 | awk '{sum+=$4} END {print sum}'
git cat-file -s HEAD:.ak/dockets/issues/10/migration/v3-reconstruction/final-recorder-hygiene-closure.md
```

## Ancestry

```bash
git merge-base --is-ancestor 6e76efa93588844996611b86320de7747cca3d24 HEAD
# exit 0

git merge-base --is-ancestor a5374fcdcc412997305cc53414a6ecc0f6845b7b HEAD
# exit 0 (also required of Final HEAD after commit)
```

## Retained-byte seal equality

```bash
python3 - <<'PY'
import json, hashlib, subprocess
from pathlib import Path
retained = json.loads(Path('.ak/dockets/issues/10/migration/v2-source/retained.json').read_text())
mismatches = []
for item in retained['items']:
    blob = subprocess.check_output(['git','rev-parse',f"HEAD:{item['path']}"], text=True).strip()
    data = subprocess.check_output(['git','cat-file','blob', blob])
    sha = hashlib.sha256(data).hexdigest()
    if blob != item['blobOid'] or sha != item['sha256'] or len(data) != item['bytes']:
        mismatches.append(item['path'])
print(len(retained['items']), len(mismatches))
PY
```

Result at starting HEAD: **71 retained items, 0 mismatches** (blob OID, SHA-256, byte length).
This commit does not touch any retained path; seals remain byte-identical at Final HEAD.

## Omission dispositions

- `migration/v2-source/omitted.json`: **28** items; sole disposition
  `excluded execution exhaust`
- `.ak/dockets/issues/10/apply/apply-001/coder-incomplete.json` preserved
  - bytes **1437**
  - SHA-256 `2e88183b1baa2713df7466427cfddccbe423bca76d670ec5ac4ad019b347f383`
  - HEAD blob `ae72c146a2296569aa8d2afbad98682b7a644698`
  - `lawfulReceipt: null`
- **No Coder Receipt was manufactured.**

## No newly introduced generic session/tool-event exhaust

Path/name/object presence only (no archived payload inspection; posture fixtures
not audited):

```bash
git ls-tree -r --name-only HEAD .ak/dockets/issues/10 \
  | rg -i 'session\.jsonl|tool-event|tool_event|raw-session|(^|/)cold/' || true
# no matches

git log --diff-filter=A --name-only --pretty=format: \
  6e76efa93588844996611b86320de7747cca3d24..HEAD \
  | rg -i 'session\.jsonl|tool-event|tool_event|raw-session|(^|/)cold/' || true
# no matches
```

## Mergeability

```bash
git merge-tree --write-tree 6e76efa93588844996611b86320de7747cca3d24 HEAD
# 6ea2d2094743fce38e02ed144f79320bcfe03ae2
# exit 0 (no conflict failure) at starting HEAD; re-check at Final HEAD in Receipt
```

## Package inventory

Dry-run and clean-install both inventory **58** package files (identical path
sets), including `bin/ak-docket-record.js`, `dist/recorder/*`, `src/recorder/*`,
`schemas/recorder-manifest-v1.schema.json`, and `README.md`. Temporary tarball
and consumer directories were removed after the install probe.

## Residue and status targets

```bash
find . -maxdepth 3 \( -name '*.tgz' -o -name '*scratch*' -o -name '*consumer*' \) -print
# expected: no hits after cleanup

[ ! -L node_modules ]; echo $?
# 0

git status --short
# expected empty after evidence commit
```

## Explicit non-actions

- No archived session payload inspection
- No edit of `final-recorder-reconstruction.md` or `report.json`
- No retained-seal mutation (including `materials.md` EOF blank)
- No manufactured Coder Receipt / no change to `coder-incomplete.json`
- No behavior expansion, test weakening, amend/rebase/rewrite
- No unrelated cleanup beyond authorized hygiene + this record

## Authorized commit shape

One forward commit staging only:

1. `src/recorder/errors.ts`
2. `dist/recorder/errors.js`
3. `.ak/dockets/issues/10/migration/v3-reconstruction/final-recorder-hygiene-closure.md`
