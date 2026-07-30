# Reviewer receipt

Reviewed target `7bace1674eeadcfc582cea4ba28c3f6b3086791e` against fixed point `4509371219be8601c4f6e538b92885f946918515`.

## Standards

### Finding

- **Medium — Hard documented-behavior violation — `src/canonical-skill-binding.ts:47,74-79`**  
  The new binding stores the real path — `"path = await realpath(configuredPath)"` — then requires `parsed.location === snapshot.path` and content based on that real-path directory. Pi’s native expansion preserves the explicitly supplied Skill path and its directory. Consequently, if the documented `~/.agents/skills/tdd/SKILL.md` is a symlink, the canonical Skill loads successfully but every valid native expansion is rejected, so Coder can never submit `completed`. This conflicts with `README.md:94-108`’s supported invocation and exact-native-expansion contract. It also contradicts the symlink scenario deliberately established by `test/canonical-skill-binding.test.ts:35-64`, which never crosses the actual Pi expansion boundary.  
  A scratch-only probe confirmed the mismatch: snapshot location was the symlink target while Pi’s location remained the configured symlink. The shared module is otherwise a genuine deep consolidation, not a shallow rename.

No baseline smell findings.

### Verification

HEAD exactly `7bace1674eeadcfc582cea4ba28c3f6b3086791e`; fixed point is its strict parent, with one commit. Souls are byte-identical and the tracked target remained clean. After scratch-only `npm ci`, typecheck passed; isolated-HOME tests passed (92/92); `npm pack --dry-run` contained the expected 14 files and no Skill; `git diff --check` passed.

## Spec

- **Medium — Pre-prefixed TDD invocation without arguments can never satisfy completion provenance.** The approved plan requires: “Preserve the existing pre-prefixed `/skill:tdd` no-double-prefix behavior, deriving the expected Pi argument text for structural comparison.” (`/tmp/ak-skill-coder-plan.md`, step 4). For input exactly `/skill:tdd`, `src/role-runtime.ts:896-898` records the normalized request as `""`. Pi’s native expansion omits `userMessage`, so `parseSkillBlock` returns `undefined`; `src/canonical-skill-binding.ts:80` then rejects the genuine expansion because `undefined !== ""`. Consequently a valid immediately-following canonical expansion cannot authorize `completed`. Existing coverage only tests `/skill:tdd <nonempty request>`.

No unasked-for product scope creep identified.

Verification: HEAD remained `7bace1674eeadcfc582cea4ba28c3f6b3086791e`; baseline is the merge-base, exactly one forward commit, and the tree is clean. After scratch-only `npm ci` populated ignored `node_modules`, typecheck and all 92 empty-HOME tests passed. Dry-run package contained the shared runtime and no `SKILL.md` or deleted reviewer module; `git diff --check` passed. A scratch probe reproduced the empty-request mismatch.

Summary: Standards — 1 finding; worst: symlinked canonical Skill cannot complete. Spec — 1 finding; worst: bare pre-prefixed `/skill:tdd` cannot complete.
