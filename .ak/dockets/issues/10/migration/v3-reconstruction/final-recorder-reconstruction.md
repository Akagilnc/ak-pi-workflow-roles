# Final Recorder reconstruction evidence

Append-only reconstruction closure for the in-place Recorder salvage on
`feature/durable-invocation-dockets-v3`. This report does not rewrite historical
migration/report bytes. The earlier `copiedSmallBytes: 224089` figure in
`report.json` is **historical** (v3 copy inventory at reconstruction time) and
is superseded for current-tree sizing by the tracked logical-byte totals below.

## Baseline

| Fact | Value |
| --- | --- |
| Recorded default SHA | `6e76efa93588844996611b86320de7747cca3d24` |
| Adjudicated incomplete-Apply HEAD | `6fbf3d627e59d02339c5c7cb7b637c6511f054c4` |
| Implementation tip before this report | `83b368b5c8194d749901547bf1cfb6775272444a` |
| Branch | `feature/durable-invocation-dockets-v3` |

### Ancestry commands

```bash
git merge-base --is-ancestor 6e76efa93588844996611b86320de7747cca3d24 HEAD
# exit 0

git merge-base --is-ancestor 6fbf3d627e59d02339c5c7cb7b637c6511f054c4 HEAD
# exit 0
```

## Forward commits since incomplete-Apply disposition

```text
83b368b5c8194d749901547bf1cfb6775272444a fix(package): ship standalone recorder executable
f374f4e43dcf0e341bd824822d778655b5105e23 fix(recorder): enforce atomic transaction outcomes
f5111f7ea70cfbf807d055a7529c9680558744ae fix(recorder): close scan admission and manifest law
306ce3060a0a3e8299845223fecd31c6073e23fe fix(recorder): bind package acceptance contracts
6d946f35adf5889408773c59b1950ebf5c04041d docs(docket): preserve converged salvage plan receipt
78799fcfa85b8e776be759633e0f452637c85f45 docs(docket): preserve Recorder salvage plan receipt
```

Plus this evidence commit (Final HEAD recorded at end).

## Retained-byte seal equality

Command:

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

Result: **71 retained items, 0 mismatches** (blob OID, SHA-256, and byte length).

## Omission dispositions

- `migration/v2-source/omitted.json`: **28** omitted session/tool-event paths with disposition `excluded execution exhaust`.
- `.ak/dockets/issues/10/apply/apply-001/coder-incomplete.json` preserved as the missing Coder Receipt disposition (`lawfulReceipt: null`).
- **No Coder Receipt was manufactured.**

## No newly introduced generic session/tool-event exhaust

Commands limited to path/name/object presence in reconstructed issue-10 tree and ancestry (no archived payload inspection; posture fixtures not audited):

```bash
git ls-tree -r --name-only HEAD .ak/dockets/issues/10 | rg -i 'session\.jsonl|tool-event|tool_event|raw-session|cold/' || true
# no matches

git log --diff-filter=A --name-only --pretty=format: 6e76efa93588844996611b86320de7747cca3d24..HEAD | rg -i 'session\.jsonl|tool-event|tool_event' || true
# no matches
```

## Mergeability

```bash
git merge-tree --write-tree 6e76efa93588844996611b86320de7747cca3d24 HEAD
# 8bb061b70cde77831dbae4c327cc5cea64fbe421
```

Clean merge-tree result at the implementation tip (no conflict failure).

## Exact tracked logical-byte totals

At implementation tip `83b368b5c8194d749901547bf1cfb6775272444a`:

```bash
git ls-tree -r -l HEAD | awk '{sum+=$4} END {print sum}'
# 9839489

git ls-tree -r -l HEAD .ak/dockets/issues/10 | awk '{sum+=$4} END {print sum}'
# 254538
```

This report path:
`.ak/dockets/issues/10/migration/v3-reconstruction/final-recorder-reconstruction.md`

After this evidence commit, recompute:

```bash
git ls-tree -r -l HEAD | awk '{sum+=$4} END {print sum}'
git ls-tree -r -l HEAD .ak/dockets/issues/10 | awk '{sum+=$4} END {print sum}'
git rev-parse HEAD
git cat-file -s HEAD:.ak/dockets/issues/10/migration/v3-reconstruction/final-recorder-reconstruction.md
```

Predicted final totals with this file at 5445 bytes: whole=9844934, issue-10=259983.

## Historical size note

`migration/v3-reconstruction/report.json` records `copiedSmallBytes: 224089` from the
small-core copy step. That number is retained as a historical inventory fact and
is **not** the current whole-tree or issue-10 tracked logical-byte total.

## Gates (implementation tip)

```bash
npm run typecheck
# exit 0

node --import tsx --test \
  test/recorder-admission.test.ts \
  test/recorder-cli.test.ts \
  test/recorder-extract-scan.test.ts \
  test/recorder-package-lifecycle.test.ts \
  test/recorder-transaction.test.ts
# 31/31 pass

npm test
# 290/290 pass

npm pack --dry-run --json
# 58 packed files; inventory matches Reviewer snapshot
```

## Explicit non-actions

- No archived session payload inspection
- No `/tmp` archaeology
- No rewrite of historical reports/manifests
- No manufactured Coder Receipt
- No parallel archive/cold/session subsystem

## Final HEAD

The Final HEAD is the Git commit that introduces this file
(`.ak/dockets/issues/10/migration/v3-reconstruction/final-recorder-reconstruction.md`).
Resolve with:

```bash
git log -1 --format=%H -- .ak/dockets/issues/10/migration/v3-reconstruction/final-recorder-reconstruction.md
```
