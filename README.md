# @ak/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev). Supported roles: `judge`, `fixer`, and `coder`.

## Judge

The judge role:

1. loads the bundled [`souls/judge.md`](souls/judge.md) into the system prompt;
2. lets the active Pi model adjudicate with normal tools;
3. accepts a final verdict only through `ak_judge_output`;
4. runs a separate Soul-compliance model call before accepting the verdict;
5. returns a terminating structured tool result only after the audit passes.

The compliance call uses the active Pi model and credentials. It checks demonstrated procedural compliance with the Soul; it does not replace the judge's substantive finding decisions.

On activation, Judge narrows active tools to the registered members of this exact whitelist: `read`, `grep`, `find`, `ls`, `bash`, and `ak_judge_output`. In particular, `write`, `edit`, and arbitrary sibling tools are inactive. This is role gating to prevent accidental role drift, not a security boundary; callers that need isolation must provide a sandbox or container.

## Install

Project-local installation:

```bash
pi install -l /absolute/path/to/ak-pi-workflow-roles
```

Temporary invocation without installation:

```bash
pi -e /absolute/path/to/ak-pi-workflow-roles \
  --ak-role judge \
  --mode json \
  -p "Judge the supplied review materials."
```

After installation:

```bash
pi --ak-role judge --mode json -p "Judge the supplied review materials."
```

The caller should treat the successful `ak_judge_output` tool result as the authoritative receipt. Plain assistant text is not a completed judge verdict.

## Fixer

The fixer role loads `souls/fixer.md` plus the judge-authored Markdown repair packet, then repairs/tests or returns an evidence-bearing refusal:

The CLI advertises the complete phase vocabulary in `pi --ak-role fixer --help`:

| `--ak-fixer-phase` | Meaning | Legal success status |
| --- | --- | --- |
| `plan` | Inspect and propose a repair plan; do not edit or commit | `planned` |
| `apply` | Execute the approved plan, verify, and commit when repaired | `completed` |

There is no third phase. Either phase may return `refused` with evidence.

```bash
pi --ak-role fixer \
  --ak-fixer-phase plan \
  --ak-fix-packet /path/to/fix-packet.md \
  -p "Prepare the repair plan."

pi --ak-role fixer \
  --ak-fixer-phase apply \
  --ak-fix-packet /path/to/approved-fix.md \
  -p "Apply the approved repair plan."
```

Fixer terminates through `ak_fixer_output`:

```json
{"status":"planned|completed|refused","report":"Markdown report","commitSha":"optional self-report"}
```

`planned` cannot carry `commitSha`. Otherwise `commitSha` is advisory evidence for the judge, not a hard gate. Fixer never emits `escalate`; requested owner decisions return as `refused` evidence and the judge decides whether to escalate. The caller transports the report, live Git history, and any fresh review back to the judge.

## Coder

Coder handles first implementation in two explicit phases:

| `--ak-coder-phase` | Meaning | Legal success status |
| --- | --- | --- |
| `plan` | Inspect the task and propose an implementation plan; do not edit or commit | `planned` |
| `apply` | Execute the Judge-approved plan and verify the first implementation | `completed` |

Either phase may return `refused` with authority and current-code evidence. A refusal does not require a commit and returns to the Judge for adjudication; Coder never emits `escalate`.

```bash
pi --ak-role coder \
  --ak-coder-phase plan \
  --ak-coder-task /path/to/task.md \
  -p "Prepare the implementation plan."

pi --no-skills \
  --skill ~/.agents/skills/tdd/SKILL.md \
  --ak-role coder \
  --ak-coder-phase apply \
  --ak-coder-task /path/to/approved-plan.md \
  -p "Apply the approved implementation plan."
```

Coder terminates through `ak_coder_output` with the same thin worker envelope:

```json
{"status":"planned|completed|refused","report":"Markdown report","commitSha":"optional self-report"}
```

During `apply`, the runtime transforms the first input through Pi's native `/skill:tdd`. Use `--no-skills --skill ~/.agents/skills/tdd/SKILL.md` to bind the canonical Matt TDD skill without name collisions. A `completed` receipt is rejected unless the session transcript contains Pi's expanded `<skill name="tdd" ...>` block; an evidence-bearing `refused` receipt does not require TDD or a commit.

The completed report must preserve TDD evidence plus the same-pattern, introduced-regression, and behavior-fact self-check results for the Judge. These are report/audit requirements, not a second bundled Skill. `commitSha` remains advisory evidence rather than a hard package gate.

## Verdict contract

- `converged`
- `continue` with non-empty `fix.summary`
- `escalate` with `decisionGate.question` and non-empty `decisionGate.options`

Any verdict may additionally carry an optional non-empty `note` Markdown string. It is an advisory addendum for important information or requirements that should remain separate from the status-specific fields. It has no built-in routing or execution semantics, and callers may ignore it without changing the existing verdict flow.

Workflow ordering and routing belong to a separate orchestrator.

## Development

```bash
npm test
npm run typecheck
```
