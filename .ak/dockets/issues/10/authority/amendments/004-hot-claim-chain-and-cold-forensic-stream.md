# Owner correction 004: hot claim chain and cold forensic stream

External measurement of issue #10 found approximately 164 KiB of decision-bearing claim-chain artifacts versus 398 MiB of session streams. The owner requires ordinary issue material in the tracked repository to remain on the order of a few MiB, not hundreds. This correction refines amendment 003 and answers Judge-004's `continue` findings; it does not discard historical evidence.

## Two storage temperatures

The **hot core docket** is the tracked, directly searchable decision/evidence chain. It contains manifests, Receipts, authority, plans, reviews, finding dispositions, redaction reports, non-Git external inputs required by the claim chain, and specifically admitted exhibits. It never contains raw session exhaust merely because capture observed it. Existing Git-resolvable bytes are referenced, never copied.

The **cold forensic stream** is the complete sanitized parent-invocation event stream retained outside the authority repository's ordinary Git object graph. It is not institutional memory, a claim, a summary, a role ledger, or a normal review/search surface. Its purpose is later forensic retrieval if extraction, audit, execution, or provenance is disputed. The hot manifest binds its durable locator, storage format/version, reconstructed byte length and SHA-256, stored-object length and SHA-256, credential-scan/redaction status, and availability verification time. A digest without a retrievable durable locator is not a cold archive and must not be described as preserved.

Every caller-designated formal invocation produces a cold forensic object after credential scanning. Caller-owned **evidence admission** decides only whether a specific raw event range/object is cited into the hot claim chain as a necessary exhibit; it does not decide whether the cold forensic object is retained. Curiosity still does not make raw events a hot exhibit.

## Git reference law

For the hot core, any exact bytes already recoverable from Git are represented only by repository identity, full commit SHA, path, blob OID, and SHA-256 verified against the object. Tool/session echoes never create a second hot payload.

Cold forensic streams preserve the sanitized event exchange as observed. Repeated Git bytes embedded in that exchange are part of the forensic transcript, not independent hot exhibits. V1 does not introduce reference-substitution reconstruction inside cold streams; that optimization is rejected for now because it adds framing/resolution failure modes and weakens standalone forensic retrieval. Lossless compression addresses physical duplication. This is an explicit cold-stream exception, not a silent exception to hot-core deduplication.

## Non-circular sealing lifecycle

Already-committed inputs may use verified Git coordinates. New canonical decision artifacts and generated Receipts are first stored exactly once in a pending hot docket with their byte digests and no claim of a containing commit. After the caller commits them, a later append-only seal record or manifest generation may add full commit/path/blob coordinates. The Recorder never commits or predicts a future commit SHA. Dirty bytes never masquerade as committed references. A pending artifact may support the current invocation by path+digest but cannot claim durable Git resolvability until forward sealing.

## State and failure lifecycle

The Recorder executes the exact caller command once, captures raw scratch, scans/redacts it, constructs and durably writes the cold object, verifies retrieval and reconstructed digest, then atomically promotes the hot core that cites it. There is no post-exit retain/delete decision and no indefinite admission wait. Caller exhibit selections supplied before promotion affect only hot citations; after-the-fact new citations are append-only hot amendments pointing to the existing cold object, never a retry or second spawn.

If no valid caller exhibit selection exists, no raw event is admitted into the hot claim chain; the complete cold object is still retained. Mandatory authority/task/input bytes and evidence required to support a claim cannot be omitted by disposition: they must be represented by verified Git reference or stored once in hot core, otherwise archival promotion fails.

Cold write, retrieval verification, compression/reconstruction, admission, Git-reference verification, redaction, cleanup, or hot promotion failures follow the frozen Recorder-infrastructure precedence and never synthesize a Receipt. Raw scratch is deleted only after verified cold durability and successful/failed hot finalization as specified by cleanup law; crash residue remains the documented host risk.

## Minimal cold-store seam

V1 owns only a caller-selected cold-root filesystem seam and a durable opaque locator returned from writing one losslessly compressed object. The caller owns making that root durable/remote, permissions, retention, and future availability. Hot promotion requires immediate write/read verification, but the package does not promise indefinite availability. No Git LFS, GitHub-specific release API, object-storage SDK, content-addressed service, database, catalog, daemon, encryption/key management, replication, or retention policy is added. A future second real adapter may justify a broader cold-store interface.

## Legacy and current branch disposition

The one-time historical migration creates the small hot claim chain and moves only complete sanitized session streams to caller-selected cold storage. It records recovered/known-missing/excluded states and never copies Git-resolvable source artifacts into hot payloads. The current feature branch's already tracked 398 MiB bootstrap sessions are the capacity counterexample, not the desired merge shape. Before merge, a separately authorized branch/history replacement or equivalent Git-object-removing migration is required; forward deletion alone is insufficient. Preserve the current remote branch/commit identities as migration source until cold durability and hot-core equivalence are independently verified.
