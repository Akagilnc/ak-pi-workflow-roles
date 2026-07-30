# Issue #3 provenance Fixer receipt

```json
{
  "status": "completed",
  "report": "## Completed: Issue #3 recording provenance residual\n\n### Base / result\n- Start HEAD: `5933d20` (authorized)\n- New HEAD: `0546c8b` (strict forward descendant; no amend)\n\n### Red captured\nAdded `extractUniqueAssistantProvenance` + meta cross-check first. Focused oracle failed both bundles:\n- expected `openai-codex` / actual `xai` (unique JSONL pair was already `openai-codex`/`gpt-5.6-sol`)\n\n### Green applied\n1. `test/fixtures/judge-postures/r-block/meta.json` — provider/model only → `openai-codex` / `gpt-5.6-sol`\n2. `test/fixtures/judge-postures/r-ready/meta.json` — same\n3. `test/judge-posture-recordings.test.ts` — helper scans completed assistant `message_end` only; requires unique non-empty pair; asserts `meta.provider`/`meta.model` equality inside existing per-bundle oracle\n\nUntouched: soulDigest, packageSha, recordedAt, note, JSONL, receipts, Soul, src/runtime.\n\n### Verification\n- `node --import tsx --test test/judge-posture-recordings.test.ts` — 10/10 pass\n- `npm run typecheck` — pass\n- `npm test` — 249/249 pass\n\n### Commit\n`0546c8b` fix(judge): align posture meta provenance with JSONL truth\n\nBody documents sidecar correction to JSONL truth + oracle cross-check; no Soul/re-record.",
  "commitSha": "0546c8bdbadfa4f27c2ea2fafa9b9ae4cde9e372"
}
```
