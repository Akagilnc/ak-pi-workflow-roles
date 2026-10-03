# Frozen replay (caller-side tool)

Replays one recorded seat run against the materials it saw at the time, so a Soul or law
edit can be tested against a real past case before it lands. Not part of the public CLI;
no tests; the caller who uses it fixes it.

```
scripts/replay/replay-run.sh freeze <run-dir> [--cut <ISO>] [--head <sha>]
scripts/replay/replay-run.sh run    <kit> <arm> <n> [--sys <edited sys.txt>] [--effort low|medium|high]
scripts/replay/replay-run.sh show   <kit> [<arm>]
scripts/replay/replay-run.sh clean  <kit>
```

`freeze` writes `~/.ak-roles/replays/<runId>/`: the ticket body as of the cut (from the
issue's edit history), diarist records up to the cut, the run's system prompt with the
historical records pointer (if present) swapped to the frozen copy and a `<frozen_replay_notice>` naming the frozen records for all runs, the
admitted instruction, the output schema, and a detached worktree at the judged HEAD.
`run` starts one leg in its own detached worktree (`wt-<arm>-<n>`): codex with `--sandbox read-only`;
pi with `--system-prompt` when `sysKind` is `turn-delivery` (full recorded prompt) and
`--append-system-prompt` only for rebuilt `pi-tail`; `gh` resolves to `bin/gh`, which serves the frozen issue and
blocks every mutation (login shells included, via `zdot/`). `show` prints the verdicts; `clean` removes the kit and its worktrees.

Limits: pi legs have no sandbox (`node_modules` is a symlink into the real checkout, and a
`gh` called by absolute path is not intercepted); codex legs are network-blocked by the
sandbox. Hosts other than codex and pi are refused at freeze time.

Treatment arm: copy `sys.txt`, edit the Soul/law text inside it, pass it with `--sys`.
When a `turn-delivery` row exists at or before the cut, freeze takes that recorded
system prompt for every host (including pi). Only runs with no such row fall back to
rebuilding a pi tail from the frozen worktree (`pi-tail.ts`). Coder/fixer runs may still
carry extra phase/task blocks a rebuilt tail does not reproduce, so hand-build `--sys`
there when needed.
