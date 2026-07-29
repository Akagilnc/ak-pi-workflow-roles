# Authority amendment 001: legacy history and bounded physical storage

Owner adds two requirements before Authority convergence.

## Legacy dossier import

The package's growth history is itself durable evidence. Construction must include a one-time import of the currently recoverable historical role-development artifacts from volatile `/tmp` storage: authority materials, plans, repair packets, full role session JSONL, typed Receipts, reviews, findings, adjudications, probes that served as evidence, and closure reports for the Judge/Fixer/Coder/Reviewer/Collector and issue #1–#3 work.

Import preserves discovered original bytes when they pass the credential boundary. If redaction is required, preserve only the sanitized derivative plus a non-secret redaction report; never commit the raw secret. Each imported file records a sanitized source locator, discovery time, byte length, digest, redaction status, and any known issue/PR/commit association. The import must not claim historical completeness: `/tmp` is volatile, so the manifest distinguishes `recovered` from `known missing` and records selection/exclusion reasons.

Do not duplicate recoverable source trees, worktree clones, `node_modules`, package builds, or files whose exact bytes are already addressable by repository commit/path/digest. Preserve historical reasoning/evidence artifacts even when superseded; later dispositions link them rather than overwrite them.

This migration is contributor construction work, not Recorder runtime behavior, package memory, a retention daemon, or automatic repository archaeology.

## One logical stream, bounded physical blobs

The first dogfood Authority Judge session produced a 152,358,678-byte JSONL because repository inspection encountered checked-in recording evidence. A single physical blob exceeds common Git-host limits despite being valuable and line-addressable. Therefore `session.jsonl` denotes one canonical **logical ordered event stream**, not necessarily one physical file.

The archive may store it as either one plain `session.jsonl` or deterministic ordered plain-JSONL chunks under `session/`, with a versioned manifest that records chunk order, each chunk digest/length, total logical-stream byte length, and a digest of exact concatenated bytes. Chunk boundaries must occur only between complete JSONL records; concatenation must reproduce the sanitized canonical stream byte-for-byte. No event may be omitted, duplicated, reordered, summarized, or interpreted. Chunking is storage transport, not a parallel archive shape, index, child-session forest, or semantic ledger.

Compression, Git LFS, content-addressed stores, databases, and archive services remain deferred until a real host constraint requires one. Plain chunks preserve `rg`, `jq`, diff, and ordinary Git distribution.
