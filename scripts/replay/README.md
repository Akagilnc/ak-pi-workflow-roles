# Frozen replay (caller-side tool)

Replays one recorded seat run against the materials it saw at the time, so a Soul or law
edit can be tested against a real past case before it lands. Not part of the public CLI;
no tests; the caller who uses it fixes it.

```
scripts/replay/replay-run.sh freeze <run-dir> [--cut <ISO>] [--head <sha>]
scripts/replay/replay-run.sh run    <kit> <arm> <n> [--sys <edited sys.txt>] [--effort low|medium|high]
scripts/replay/replay-run.sh show   <kit> [<arm>]
```

`freeze` writes `~/.ak-roles/replays/<runId>/`: the ticket body as of the cut (from the
issue's edit history), diarist records up to the cut, the run's system prompt with the
records pointer swapped to the frozen copy and a `<frozen_replay_notice>` on top, the
admitted instruction, the output schema, and a detached worktree at the judged HEAD.
`run` starts one leg in that worktree: codex with `--sandbox read-only`, pi with
`--append-system-prompt`; `gh` resolves to `bin/gh`, which serves the frozen issue and
blocks every mutation (login shells included, via `zdot/`). `show` prints the verdicts.

Treatment arm: copy `sys.txt`, edit the Soul/law text inside it, pass it with `--sys`.
Pi-host runs get their tail rebuilt from the frozen worktree (`pi-tail.ts`); coder/fixer
runs carry extra phase/task blocks the tail does not reproduce, so hand-build `--sys` there.
