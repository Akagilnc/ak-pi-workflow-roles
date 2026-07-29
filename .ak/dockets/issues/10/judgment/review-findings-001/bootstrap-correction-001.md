# Bootstrap correction 001

Append-only documentary correction for issue #10 review-findings-001. Historical bootstrap artifacts are preserved byte-for-byte; this record seals omitted input digests and supersedes only one stale range assertion.

## Sealed Judge-001 authority input

Judge-001 input, omitted as a digest from `authority/judge-001/manifest.json`:

| Path | SHA-256 |
| --- | --- |
| `.ak/dockets/issues/10/authority/materials.md` | `54f5522f47a52d87d8a6fcaa81a50ab3707de109a53ff371bf6df7b541d19c5b` |

## Sealed Judge-002 authority inputs

Judge-002 primary input, omitted as a digest from `authority/judge-002/manifest.json`, and the three artifacts it references:

| Path | SHA-256 |
| --- | --- |
| `.ak/dockets/issues/10/authority/request-002.md` | `e13c973d49b3f7794cb423051987caa7642c4678b749f9a980c7a9516728c3fb` |
| `.ak/dockets/issues/10/authority/materials.md` | `54f5522f47a52d87d8a6fcaa81a50ab3707de109a53ff371bf6df7b541d19c5b` |
| `.ak/dockets/issues/10/authority/amendments/001-legacy-import-and-logical-stream.md` | `cca7da9f54c13e13e1563de7d5af4b20dd0ca8b0a32bb15afec4f948f4cf94f3` |
| `.ak/dockets/issues/10/authority/judge-001/receipt.json` | `663f2a6dd1aead62225f57b8f8a04eec132f674b2c235fb1eb820304241dff72` |

Accepted manifests and Receipts are not rewritten.

## Superseded review-range assertion

Preserved bootstrap artifact (bytes unchanged):

| Path | SHA-256 |
| --- | --- |
| `.ak/dockets/issues/10/review/review-001/target.json` | `cdd28ae7b8a22ca3a81ec3acc024c39f462d958f87fc64a691cd52d8e9c3cd9a` |

That file's target/range assertion is stale. It names target `71e8a5aabe1dee5c7340a19a0e80db376c77621a`. Only that stale range assertion is superseded here.

The actual immutable review range, already corroborated by `.ak/dockets/issues/10/review/review-001/manifest.json` (`reviewedBase` / `reviewedTarget`) and `.ak/dockets/issues/10/review/review-001/receipt.json`, is:

```text
6e76efa93588844996611b86320de7747cca3d24..49796e44202e8024c712b0e50a482f7882cf30cd
```

No review rerun, artifact deletion, role routing, schema mechanism, Recorder implementation, or other historical rewrite is authorized by this correction.
