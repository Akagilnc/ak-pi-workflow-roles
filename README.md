# @ak/pi-workflow-roles

Packaged workflow roles for [Pi](https://pi.dev). Supported roles: `judge` and `fixer`.

## Judge

The judge role:

1. loads the bundled [`souls/judge.md`](souls/judge.md) into the system prompt;
2. lets the active Pi model adjudicate with normal tools;
3. accepts a final verdict only through `ak_judge_output`;
4. runs a separate Soul-compliance model call before accepting the verdict;
5. returns a terminating structured tool result only after the audit passes.

The compliance call uses the active Pi model and credentials. It checks demonstrated procedural compliance with the Soul; it does not replace the judge's substantive finding decisions.

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

The fixer role loads `souls/fixer.md`, applies the judge-authored repair packet, runs the repository's required checks, and creates a new forward commit without amending history:

```bash
pi --ak-role fixer -p "Apply this judge repair packet: ..."
```

The caller owns the mechanical Git gate: the new HEAD must be a strict forward descendant of the prior HEAD. Fixer emits no judge status; fresh review and the judge decide convergence.

## Verdict contract

- `converged`
- `continue` with non-empty `fix.summary`
- `escalate` with `decisionGate.question` and non-empty `decisionGate.options`

Workflow ordering and routing belong to a separate orchestrator.

## Development

```bash
npm test
npm run typecheck
```
