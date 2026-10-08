# Frozen replay (caller-side tool)

Replays one recorded seat run against the materials it saw at the time, so a Soul or law
edit can be tested against a real past case before it lands. Not part of the public CLI;
no tests; the caller who uses it fixes it.

```
scripts/replay/replay-run.sh freeze <run-dir> [--cut <ISO>] [--head <sha>]
scripts/replay/replay-run.sh run    <kit> <arm> <n> [--sys <edited sys.txt>] [--schema <edited schema.json>] [--effort low|medium|high]
scripts/replay/replay-run.sh show   <kit> [<arm>]
scripts/replay/replay-run.sh clean  <kit>
```

`freeze` writes `~/.ak-roles/replays/<runId>/`: the ticket body as of the cut (from the
issue's edit history), diarist records up to the cut, the run's system prompt when a
`turn-delivery` row recorded one (with the historical records pointer swapped to the
frozen copy when present) and a `<frozen_replay_notice>` naming the frozen records,
the admitted transport prompt (instruction plus caller file-flag paths via the same
projection production uses), the output schema when recorded, and a detached worktree at
the judged HEAD. Missing turn-delivery prompt/schema is declared as a gap in `meta.json`
and on stdout — freeze does not reconstruct them. `run` starts one leg in its own
detached worktree (`wt-<arm>-<n>`): codex with `--sandbox read-only`; pi with
`--system-prompt` from the kit (or `--sys`); `gh` resolves to `bin/gh`, which serves the
frozen issue and
blocks every mutation (login shells included, via `zdot/`). `show` prints the verdicts; `clean` removes the kit and its worktrees.

Limits: pi legs have no sandbox (`node_modules` is a symlink into the real checkout, and a
`gh` called by absolute path is not intercepted); codex legs are network-blocked by the
sandbox. Hosts other than codex and pi are refused at freeze time.

Treatment arm: copy `sys.txt`, edit the Soul/law text inside it, pass it with `--sys`; a treatment that changes the receipt shape copies `schema.json` and passes `--schema`.
The run the seat audited (admitted `sourceRunPath`) is frozen into `run/` beside it and the prompt repointed there, so audit seats (notary, auditor) read the audited verdict from the kit.
When `sysKind` is `missing-turn-delivery`, pass `--sys` with an experimental prompt — the
kit does not invent one. Coder/fixer runs may still carry extra phase/task blocks beyond
what a single turn-delivery row holds; hand-build `--sys` there when needed.
