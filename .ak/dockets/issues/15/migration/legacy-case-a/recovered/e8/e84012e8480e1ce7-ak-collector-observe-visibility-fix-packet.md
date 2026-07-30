# Collector observe visibility repair packet

## Sustained root defect

At clean HEAD `6fc54e117ebc5e43414015c6e02ef332e9f7d2af`, `src/collector-role.ts` returns the bounded `modelView` only as `details`; `content` is only `Observed snapshot …`. Pi persists `details` for host/rendering/state, but provider conversion emits tool-result `content` only. A direct `convertResponsesMessages` reproduction emitted only that summary and omitted review `evidenceId`, author, state, and `commitOid`. Both cited transcripts independently then called `ak_collector_request`; the runtime correctly rejected the request because the hidden ledger evidence contained an exact-head qualifying review. Existing role tests falsely read `toolResult.details` from faux-provider callbacks rather than proving provider-visible content.

## Smallest repair packet

1. **Repair only the observe presentation seam in `src/collector-role.ts`.** Reuse the single `modelView` already returned by `ledger.observe`. Return its compact JSON serialization as the observe tool's text content (exactly `JSON.stringify(modelView)`), while retaining the same object unchanged in `details`.
2. Do not add another evidence projection/source, expose raw GitHub JSON, classify valid/pending/unavailable/missing in runtime, add tools, alter ledger/receipt/schema/Soul semantics, or soften request refusal. Preserve the existing configured-author/authenticated-marker filtering and existing 8 MiB snapshot / 32 MiB materialization fail-closed bounds; do not silently truncate.
3. Add real-Pi lifecycle regression coverage that obtains all decision data **only by parsing `toolResult.content`**, never `details`:
   - Exact-head qualifying review: assert content exposes `snapshotId`, review `evidenceId`, configured author, accepted review state, and exact `commitOid`; use that content-derived ID to submit `valid`; assert accepted output and zero request/comment creation.
   - Authenticated same-head request-marker/pending comment: construct the exact marker for the manifest/leg/HEAD, assert content exposes its body/author/evidence ID plus snapshot ID/HEAD, and make the next operational call `wait`, not `request`; complete the deterministic cutoff/final-observe/missing path and assert zero comment creation.
   - In at least one test, assert the parsed content equals the JSON-normalized existing `details` view and excludes unrelated-author/raw evidence. This proves one bounded projection rather than a parallel source.
4. Keep existing `details`, self-contained output receipt, request refusal, pagination, size, narrowing, singleton, and package contracts green. Make one forward commit and run the authority gates: `npm run typecheck`; `HOME=$(mktemp -d) npm test`; `npm pack --dry-run`; `git diff --check`; leave the worktree clean.
