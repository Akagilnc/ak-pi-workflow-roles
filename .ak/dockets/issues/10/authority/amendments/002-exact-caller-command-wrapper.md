# Authority amendment 002: exact caller-command mechanical wrapper

Forward clarification of the Recorder invocation seam for issue #10.

## Exact caller-supplied command

The Recorder accepts one exact caller-supplied argv command together with caller-supplied execution context, and executes that command exactly once. It is only a mechanical capture wrapper around that single spawn.

The Recorder must not:

- select a command;
- synthesize a command;
- alter a command;
- retry a command;
- compose commands; or
- route commands.

## Ownership

- **Caller** owns the exact argv, the execution context, and all semantic dispatch (role choice, composition, routing, and meaning of the invocation).
- **Recorder package** owns only one spawn/capture operation, archive processing of the captured evidence, and separately reporting the child outcome.

An externally produced event-stream-only interface is not required.

## Preserved failure and Receipt law

This clarification does not weaken already-frozen archive-failure precedence or Receipt non-interpretation authority. Archive failure remains infrastructure failure and must not synthesize or reinterpret a role Receipt. The package reports the child outcome separately from archive success or failure; it does not own verdict interpretation or issue closure.
