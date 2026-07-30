# Issue #3 lifecycle Fixer receipt

```json
{
  "status": "completed",
  "report": "## Completed\n\nClosed the residual unordered last-write lifecycle gap in the posture acceptance oracle at 27b037d.\n\n### Root cause\n`extractAcceptedJudgeOutputs` bound payload chains but used last-write maps for call/start and joined terminals without row indices, so out-of-order and same-ID replay streams still accepted under last-write.\n\n### Fix\n- Rewrote oracle to per-ID lifecycle lists with row indices (`issued[]` / `starts[]` / `terminals[]`); no `.set` overwrite for call/start.\n- Accept only when `issued.length === 1 && starts.length === 1 && terminals.length >= 1`, `call index < start index < every terminal index`, and existing deep-equal / multi-terminal agreement gates hold.\n- Reject same-ID replay/conflict even when last-write payloads would agree.\n- Added four negatives:\n  - out-of-order terminal-first\n  - out-of-order start-before-call\n  - conflicting/replayed calls\n  - conflicting/replayed starts\n- Optional README offline bind clarification: unique ordered lifecycle; reject same-ID replay.\n\n### Scope\n- `test/judge-posture-recordings.test.ts`\n- `test/fixtures/judge-postures/README.md` (bind text only)\n- No Soul, src, schemas, runtime, or bundle re-record\n\n### Verification\n- `node --import tsx --test test/judge-posture-recordings.test.ts` — 19/19 pass\n- `npm run typecheck` — pass\n- `npm test` — 259/259 pass\n- Working tree clean; HEAD is strict forward descendant of 27b037d\n\n### Commit\n`1bcf0cf` fix(judge): require unique ordered lifecycle in posture acceptance",
  "commitSha": "1bcf0cf9a3343125653e3445af05cb3aef87abba"
}
```
