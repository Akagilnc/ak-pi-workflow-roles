# @akagilnc/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev): `judge`, `fixer`, `coder`, `reviewer`, `collector`, `doctor`, `merger`. 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Install

Install through Pi so the CLI and runtime come from the same package copy, and add Pi’s private npm bin to `PATH` once:

```bash
pi install npm:@akagilnc/pi-workflow-roles
export PATH="$HOME/.pi/agent/npm/node_modules/.bin:$PATH"
```

Update with `pi update npm:@akagilnc/pi-workflow-roles`—never a second global `npm install -g`. Inspect with `ak-role roles` and `ak-role help <role>`; set per-seat defaults with `ak-role config set judge openai-codex/gpt-5.6-sol:high`.

## Reading results

`ak-role` is the only supported way to call the package. Every run writes its complete Terminal result to stdout—read or redirect it there, never scrape Pi session files:

```bash
ak-role judge --attach ./plan.md "Review this plan." > result.txt
```

Exit status reports lifecycle honesty, not business success: every lawful typed result (including `audit_escalation`) exits zero; a failure without a lawful result exits nonzero, and its Terminal carries the Error Artifact ref and original cause instead of a fabricated receipt.

A run interrupted by a typed Codex/xAI HTTP 429 with no lawful result prints a complete `ak-role resume <runId>` command in its failure Terminal. Resume reopens the exact session; override the model for one run with the global flags. The package never auto-switches providers, only a typed 429 makes a run resumable, and unknown, terminal, or concurrently-resumed run IDs are rejected. Collector and Doctor are one-shot.

Global overrides work before or after the role: `ak-role --model xai/grok-4.5:high resume <runId>`.

Every run also prepares Navigator advice in the same Terminal. Configure it like any other seat:

```bash
ak-role config set navigator openai-codex/gpt-5.6-luna:medium
```

Receipts are typed, so callers compose roles without parsing prose; ordering and stopping stay caller-owned. Programmatic consumers derive contracts from the exported schemas in `src/package-contracts/`, not from this guide.

## Call the roles

Common flags: `--attach <file>` (repeatable, frozen at admission) and `--project <path>`. An instruction is optional for judge, collector, and doctor, and required nonblank for coder, fixer, reviewer, and merger.

```bash
# judge — adjudicate the supplied materials; infers its burden, no burden flag
ak-role judge --attach ./findings.md --attach ./adr.md "Adjudicate every finding."

# coder — first implementation; phase defaults to apply, or pass plan
ak-role coder plan "Propose the first implementation plan."
ak-role coder apply --attach ./plan.md "Implement the approved slice."
# apply binds the package-owned TDD method; do not bind a home Skill as a substitute

# reviewer — fixed-target two-axis review (Standards + Spec)
ak-role reviewer --base main --attach ./issue.md "Review the branch."
# --base is a hint; completed ≠ approved — read the findings in the Terminal

# collector — GitHub PR review evidence; github.com only, needs gh auth; one-shot
ak-role collector --pr 42 --leg codex:CodexBot --leg cursor:cursor-bot,cursor-bot-2
# legs are id:author[,author...]; repo defaults from origin, --repo owner/repo overrides

# fixer — repair the assigned findings; phase defaults to apply, or pass plan
ak-role fixer --attach ./findings.md --prerequisites ./prereqs.json "Repair the findings."
# --prerequisites is a JSON array of {id, requirement}; malformed grammar exits 2

# doctor — diagnose one retained case; one-shot
ak-role doctor --issue 115 "Diagnose this retained case."
# --runs must stay project-relative: .ak-roles/books/<book>/issues/<n>/runs matching --issue

# merger — resolve one merge already in conflict (start it first with Git’s ort)
ak-role merger --project /path/to/worktree "Reconcile the active merge."
# hands new intent/authority questions back instead of inventing authority
```

## Names

Roles are named after Tang/Song offices; the full roster and naming rule live in [README.zh-CN.md](README.zh-CN.md).

## Developer seam: raw session invocation (advanced)

Most callers never need this. The source tree retains an explicitly loadable raw-Pi seam for package development and low-level diagnosis; it is not a supported invocation recipe—external callers use `ak-role`.

A raw run loads the role runtime explicitly and selects the role through the internal flag. This is the real argv shape, taken from the CLI’s own builders and recorded runs under the ledger book:

```bash
run=~/.ak-roles/books/<book>/issues/<issue>/runs/<invocation>@<source-tree>
pi --no-extensions \
  -e <packageRoot>/extensions/role-runtime.ts \
  --no-skills --no-prompt-templates --no-themes --no-context-files \
  --session "$run/session/session.jsonl" \
  --session-dir "$run/session" \
  --ak-role judge --mode json \
  "Adjudicate the attached materials." \
  </dev/null >/dev/null 2>"$run/stderr.log"
```

`--session` names the exact session file principal (never directory-latest); `--session-dir` is its directory. Judge takes the instruction as the prompt; other roles pass durable payload files through their own internal flags (`--ak-coder-task`, `--ak-fix-packet`, and siblings), assembled by each role’s builder in `src/public-cli/*-run.ts` through the load boundary in `src/public-cli/explicit-internal.ts`. Derive flags from that source—and from recorded runs under the ledger book—never from prose.

Discipline:

- seal stdin with `</dev/null`—Pi reads a non-TTY stdin to EOF before starting, so an open background pipe parks the run forever;
- send stdout to `/dev/null`—the session file is the authoritative record and stdout is an unbounded copy surface; attach dashboards to `stderr.log` and the session file;
- keep `stderr.log` and `invocation.json` in the same `runs/` directory, as in the example above.
