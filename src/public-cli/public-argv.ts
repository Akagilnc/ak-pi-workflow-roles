/**
 * Public `ak-role` argv grammar seams shared by the production CLI and
 * internal launchers. Global-flag recognition here is the sole definition;
 * `parseArgv` in `./cli.ts` consumes it. Attachment capability is derived from
 * the real role `parse*Argv` contracts in `./invocation.ts` — not a parallel set.
 */
import { publicRoleAcceptsAttach } from "./invocation.ts";
export { publicRoleAcceptsAttach };

export type TakenPublicGlobalFlag =
  | { flag: "help"; consume: 1 }
  | { flag: "model"; consume: 1 | 2; value: string | undefined }
  | { flag: "thinking"; consume: 1 | 2; raw: string | undefined };

/**
 * If `argv[index]` is a public global flag, describe its span and payload.
 * Value/raw may be undefined when a value-taking flag is missing its argument
 * (callers decide whether that is an error). Unknown dashed tokens are not
 * global — same rule as production `parseArgv`.
 */
export function takePublicGlobalFlag(
  argv: readonly string[],
  index: number,
): TakenPublicGlobalFlag | undefined {
  const token = argv[index];
  if (token === undefined) return undefined;
  if (token === "--help" || token === "-h") {
    return { flag: "help", consume: 1 };
  }
  if (token === "--model") {
    const value = argv[index + 1];
    if (value === undefined) {
      return { flag: "model", consume: 1, value: undefined };
    }
    return { flag: "model", consume: 2, value };
  }
  if (token.startsWith("--model=")) {
    return {
      flag: "model",
      consume: 1,
      value: token.slice("--model=".length),
    };
  }
  if (token === "--thinking") {
    const raw = argv[index + 1];
    if (raw === undefined) {
      return { flag: "thinking", consume: 1, raw: undefined };
    }
    return { flag: "thinking", consume: 2, raw };
  }
  if (token.startsWith("--thinking=")) {
    return {
      flag: "thinking",
      consume: 1,
      raw: token.slice("--thinking=".length),
    };
  }
  return undefined;
}

/**
 * Index of the public command token under the real global-flag grammar
 * (`--model` / `--thinking` / `--help`; unknown dashed tokens are positional).
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
    const taken = takePublicGlobalFlag(argv, i);
    if (taken !== undefined) {
      i += taken.consume;
      continue;
    }
    return i;
  }
  return undefined;
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
