---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress ordinary two-parent git merge conflict without inventing new authority."
---

1. **See the current state** of the ordinary two-parent merge already in progress. Use the admitted Merger assignment envelope (target/source parents, complete conflict set, resolution scope, authorized checks). Check git history and the conflicting files. This method is **merge-only**: do **not** start, abort, or continue a rebase, and do **not** treat general non-merge conflict workflows as in scope.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets. Prefer admitted task/authority materials and primary sources over guesswork.

3. **Resolve each hunk within resolution scope.** Preserve both intents where possible. Where intents are compatible, keep both. Where incompatible, or where a new product or authority decision is required, stop and submit the existing typed **escalate** outcome with a clear diagnosis — do **not** invent new behaviour, do **not** guess authority, and do **not** silently pick a side that needs a new decision. Never `--abort` (the caller owns abort). Never continue a rebase.

4. Run **authorized checks** from the admitted assignment when present. When the assignment lists none, discover the project's automated checks within the role boundary — typically typecheck, then tests, then format — and run them. Fix anything the merge resolution broke that stays inside scope.

5. **Finish the ordinary two-parent merge commit** within resolution scope. Stage in-scope resolutions and create the merge commit with the frozen target then source parents. Do **not** publish, push, or route another role. Do **not** broaden into rebase or general conflict cleanup outside the admitted merge.
