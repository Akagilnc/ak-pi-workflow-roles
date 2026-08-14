/**
 * Public `ak-role` argv grammar seams shared by the CLI and internal launchers.
 *
 * Keep aligned with `parseArgv` global flags in `./cli.ts` and with each
 * role's `parse*Argv` in `./invocation.ts` (whether `--attach` is accepted).
 */

/** Span of a leading global flag at `index`, or 0 when the token is not global. */
function globalFlagSpan(argv: readonly string[], index: number): number {
  const token = argv[index];
  if (token === undefined) return 0;
  if (token === "--help" || token === "-h") return 1;
  if (token === "--model" || token === "--thinking") {
    return index + 1 < argv.length ? 2 : 1;
  }
  if (token.startsWith("--model=") || token.startsWith("--thinking=")) return 1;
  return 0;
}

/**
 * Index of the public command token under the real global-flag grammar
 * (`--model` / `--thinking` / `--help`; unknown dashed tokens are positional,
 * matching `parseArgv` in `./cli.ts`).
 */
export function publicCliCommandIndex(
  argv: readonly string[],
): number | undefined {
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      return i + 1 < argv.length ? i + 1 : undefined;
    }
    const span = globalFlagSpan(argv, i);
    if (span > 0) {
      i += span;
      continue;
    }
    return i;
  }
  return undefined;
}

/**
 * Whether the named public role's argv grammar accepts `--attach`.
 * Authority lives with the corresponding `parse*Argv` implementation:
 * every packaged role except reviewer handles `--attach`; reviewer rejects it
 * as an unknown option (transition unbound — #176 / #333).
 */
export function publicRoleAcceptsAttach(command: string): boolean {
  switch (command) {
    case "judge":
    case "coder":
    case "fixer":
    case "collector":
    case "doctor":
    case "merger":
      return true;
    default:
      return false;
  }
}

/**
 * Build argv with `--attach <path>` inserted immediately after the command
 * token when that command's public grammar accepts attachments. Returns the
 * original argv unchanged when there is no attach-capable command token.
 */
export function injectPublicAttachArg(
  argv: readonly string[],
  attachPath: string,
): readonly string[] {
  const commandIndex = publicCliCommandIndex(argv);
  if (commandIndex === undefined) return argv;
  const command = argv[commandIndex];
  if (command === undefined || !publicRoleAcceptsAttach(command)) return argv;
  const out = [...argv];
  out.splice(commandIndex + 1, 0, "--attach", attachPath);
  return out;
}
