# Capacity observation 001

This is measured Plan input, not an authority amendment or a finding.

Measured at repository HEAD `1f8071d819d596b42407823db4e75c1b9c16bb6b` after the issue #10 Authority Judge/Fixer/Reviewer closure:

| Surface | Measurement |
| --- | ---: |
| `.ak/dockets` working-tree size | 398 MiB |
| Tracked branch blob logical bytes | 417,174,041 bytes (397.8 MiB) across 67 blobs |
| Current local loose Git objects | 209.93 MiB across 986 objects |
| Archived JSONL logical size | approximately 398 MiB |
| Concatenated per-file gzip-stream estimate | 94,208,279 bytes (89.8 MiB) |
| Approximate JSONL reduction | 4.4× |

Commands used:

```bash
du -sh .ak/dockets
find .ak/dockets -type f -name '*.jsonl' -print0 | xargs -0 du -ch
git count-objects -vH
git rev-list --objects origin/feature/judge-role..HEAD |
  git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)'
find .ak/dockets -type f -name '*.jsonl' -print0 | xargs -0 gzip -c | wc -c
```

## Disposition required in Plan

Amendment 001 deferred compression, Git LFS, and content-addressed/archive services until a real host constraint. This observation establishes that one formal case already imposes hundreds of MiB of checkout/worktree material and demonstrates material lossless-compression leverage. A construction Plan must explicitly decide whether this satisfies that reserved trigger and must account for clone/worktree/review cost, not only disk price. It must preserve complete reconstructable logical event bytes, credential scanning before tracked promotion, and ordinary retrieval; this observation does not choose gzip, LFS, content addressing, or another implementation.
