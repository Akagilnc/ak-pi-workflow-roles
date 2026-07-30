Base: `d671e4f6f093a710009223105f13cddff7fbbcd7` (clean worktree).

- **Behavior:** Rename the existing integration-test title to describe its already-present both-phase Fixer bash literal seatbelt while retaining tool-surface and singleton-output coverage; no executable behavior changes.
- **Owner:** `test/package-entrypoint.integration.test.ts:568`, the title of the packaged Fixer integration test.
- **Red:** The current title, `packaged fixer enforces singleton output without inheriting Judge tool narrowing`, omits the bash seatbelt and its plan/apply coverage.
- **Green:** Replace only that title with `packaged fixer applies its both-phase bash seatbelt, retains its tool surface, and enforces singleton output`. Verify the one-line diff and run the targeted integration test using the repository’s existing test command/filter if available.
- **Scope:** Exactly one title line in one file; no test body, assertions, production code, docs, or behavior changes. Historical inspection confirms commit `e974c3c` added the both-phase seatbelt checks but retained the older title.
