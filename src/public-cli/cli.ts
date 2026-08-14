/**
 * Public ak-role CLI dispatcher (roles / config / layered help / Judge run).
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  effectiveSeatConfigurations,
  formatModelSpec,
  loadCredentialProviders,
  loadPublicCliConfig,
  parseModelSpec,
  resolveEffectiveSeat,
  savePublicCliConfig,
  setPersistentSeatConfig,
  type CredentialProviders,
  type EffectiveSeat,
  type InvocationModelOverride,
  type PublicCliConfig,
} from "./config.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { CliIo } from "./cli-io.ts";
import {
  type ExplicitInternalPiRunner,
} from "./explicit-internal.ts";
import {
  parseCoderArgv,
  parseCollectorArgv,
  parseDoctorArgv,
  parseFixerArgv,
  parseJudgeArgv,
  parseMergerArgv,
  parseReviewerArgv,
} from "./invocation.ts";
import { runPublicCoder, runPublicCoderResume } from "./coder-run.ts";
import { runPublicCollector } from "./collector-run.ts";
import { runPublicDoctor } from "./doctor-run.ts";
import { runPublicFixer, runPublicFixerResume } from "./fixer-run.ts";
import { runPublicJudge, runPublicResume } from "./judge-run.ts";
import { runPublicMerger, runPublicMergerResume } from "./merger-run.ts";
import { runPublicReviewer, runPublicReviewerResume } from "./reviewer-run.ts";
import { peekRoleRunRole } from "./run-lifecycle.ts";
import {
  INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  isPublicCliSupportCommand,
  isPublicConfigurableSeat,
  listHelpCapabilities,
  type PublicThinkingLevel,
} from "./registry.ts";
import {
  formatCliDiagnostic,
  presentStructuralRejection,
} from "./settlement.ts";
import type { TerminalResult } from "./terminal.ts";

export {
  buildExplicitInternalActivationArgs,
  resolveInternalRoleEntrypoint,
} from "./explicit-internal.ts";
export { CliUsageError } from "./cli-errors.ts";
export type { CliIo } from "./cli-io.ts";

/**
 * Sole production map: public role command → argv parser + attach capability.
 * cli handlers and the machine launcher both consume this table; no parallel set.
 */
export const PUBLIC_ROLE_ARGV = {
  judge: { parse: parseJudgeArgv, acceptsAttach: true },
  coder: { parse: parseCoderArgv, acceptsAttach: true },
  fixer: { parse: parseFixerArgv, acceptsAttach: true },
  collector: { parse: parseCollectorArgv, acceptsAttach: true },
  doctor: { parse: parseDoctorArgv, acceptsAttach: true },
  merger: { parse: parseMergerArgv, acceptsAttach: true },
  reviewer: { parse: parseReviewerArgv, acceptsAttach: false },
} as const;

export type PublicRoleArgvCommand = keyof typeof PUBLIC_ROLE_ARGV;

function isPublicRoleArgvCommand(
  command: string,
): command is PublicRoleArgvCommand {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ROLE_ARGV, command);
}

/** Table-driven attach capability from PUBLIC_ROLE_ARGV (no message matching). */
export function publicRoleAcceptsAttach(command: string): boolean {
  return (
    isPublicRoleArgvCommand(command) && PUBLIC_ROLE_ARGV[command].acceptsAttach
  );
}

type TakenPublicGlobalFlag =
  | { flag: "help"; consume: 1 }
  | { flag: "model"; consume: 1 | 2; value: string | undefined }
  | { flag: "thinking"; consume: 1 | 2; raw: string | undefined };

/**
 * If `argv[index]` is a public global flag, describe its span and payload.
 * Sole global-flag grammar for parseArgv and launcher command-index.
 */
function takePublicGlobalFlag(
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
 * Insert `--attach <path>` immediately after the command token when that
 * command's PUBLIC_ROLE_ARGV entry accepts attachments. Table-driven; no
 * independent capability scanner.
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

export type CliEnv = {
  home?: string;
  agentDir?: string;
  /** Process cwd for any Pi subprocess owned by ak-role. */
  cwd?: string;
  packageRoot: string;
  credentials?: CredentialProviders;
  io?: CliIo;
  /** Injectable Pi runner (tests); production resolves `pi` on PATH. */
  piRunner?: ExplicitInternalPiRunner;
  /** Optional caller correlation id (#78 host channel). */
  correlationId?: string;
  /** Extra Pi args for Judge runs (tests: faux provider). */
  judgeExtraPiArgs?: readonly string[];
  /** Override Judge role-run timeout (tests). */
  judgeTimeoutMs?: number;
  /** Extra Pi args for Coder runs (tests: faux provider). */
  coderExtraPiArgs?: readonly string[];
  /** Override Coder role-run timeout (tests). */
  coderTimeoutMs?: number;
  /** Extra Pi args for Collector runs (tests: faux provider). */
  collectorExtraPiArgs?: readonly string[];
  /** Override Collector role-run timeout (tests). */
  collectorTimeoutMs?: number;
  /** Extra Pi args for Doctor runs (tests: faux provider). */
  doctorExtraPiArgs?: readonly string[];
  /** Override Doctor role-run timeout (tests). */
  doctorTimeoutMs?: number;
  /** Extra Pi args for Fixer runs (tests: faux provider). */
  fixerExtraPiArgs?: readonly string[];
  /** Override Fixer role-run timeout (tests). */
  fixerTimeoutMs?: number;
  /** Extra Pi args for Reviewer runs (tests: faux provider). */
  reviewerExtraPiArgs?: readonly string[];
  /** Override Reviewer role-run timeout (tests). */
  reviewerTimeoutMs?: number;
  /** Extra Pi args for Merger runs (tests: faux provider). */
  mergerExtraPiArgs?: readonly string[];
  /** Override Merger role-run timeout (tests). */
  mergerTimeoutMs?: number;
  createRunId?: () => string;
};

export type CliResult = {
  exitCode: number;
  /** Settled Terminal when an admitted Role run produced one (programmatic/tests). */
  terminal?: TerminalResult;
};

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function defaultIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

function resolveHome(env: CliEnv): string {
  return env.home ?? process.env.HOME ?? homedir();
}

function resolveAgentDir(env: CliEnv, home: string): string {
  return (
    env.agentDir ??
    process.env.PI_CODING_AGENT_DIR ??
    join(home, ".pi", "agent")
  );
}

type ParsedGlobal = {
  command?: string;
  args: string[];
  model?: string;
  thinking?: PublicThinkingLevel;
  help: boolean;
};

function parseThinking(value: string): PublicThinkingLevel {
  if (!THINKING_LEVELS.has(value)) {
    throw new CliUsageError(`unknown thinking level: ${value}`);
  }
  return value as PublicThinkingLevel;
}

function parseArgv(argv: readonly string[]): ParsedGlobal {
  const args = [...argv];
  let model: string | undefined;
  let thinking: PublicThinkingLevel | undefined;
  let help = false;
  const positional: string[] = [];

  // Global flags may appear before or after the subcommand
  // (`ak-role --model x roles` and `ak-role roles --model x`).
  // Grammar authority: takePublicGlobalFlag above (same source as launcher).
  while (args.length > 0) {
    if (args[0] === "--") {
      args.shift();
      positional.push(...args);
      break;
    }
    const taken = takePublicGlobalFlag(args, 0);
    if (taken !== undefined) {
      if (taken.flag === "help") {
        help = true;
        args.splice(0, taken.consume);
        continue;
      }
      if (taken.flag === "model") {
        if (taken.value === undefined) {
          throw new CliUsageError("--model requires a value");
        }
        model = taken.value;
        args.splice(0, taken.consume);
        continue;
      }
      if (taken.raw === undefined) {
        throw new CliUsageError("--thinking requires a value");
      }
      thinking = parseThinking(taken.raw);
      args.splice(0, taken.consume);
      continue;
    }
    // Subcommands may own additional flags later; unknown dashed tokens stay
    // positional here (same as pre-unification parseArgv).
    positional.push(args.shift()!);
  }

  const [command, ...rest] = positional;
  return {
    ...(command === undefined ? {} : { command }),
    args: rest,
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    help,
  };
}

function invocationFromParsed(parsed: ParsedGlobal): InvocationModelOverride | undefined {
  if (parsed.model === undefined && parsed.thinking === undefined) return undefined;
  return {
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
  };
}

/** Typed facts used by help presentation — not layout. */
export function helpDocument() {
  return {
    executable: "ak-role",
    capabilities: listHelpCapabilities(),
    internalEntrypoint: INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  };
}

function renderHelp(): string {
  const doc = helpDocument();
  const lines: string[] = [
    "ak-role — public role CLI",
    "",
    "Support commands:",
  ];
  for (const cap of doc.capabilities) {
    if (cap.kind === "support") {
      lines.push(`  ${cap.name}`);
    }
  }
  lines.push("", "Callable roles:");
  for (const cap of doc.capabilities) {
    if (cap.kind === "role") {
      const phaseText =
        cap.phases.length === 1 && cap.phases[0] === null
          ? "no phase"
          : `phases ${cap.phases.filter((p) => p !== null).join("|")}` +
            (cap.defaultPhase ? ` (default ${cap.defaultPhase})` : "");
      lines.push(`  ${cap.name} — ${phaseText}`);
    }
  }
  lines.push(
    "",
    "Global options: --model provider/model --thinking level",
    "Persistent config: ak-role config set <seat> <provider/model:thinking>",
    "Effective seats: ak-role roles",
  );
  return `${lines.join("\n")}\n`;
}

function renderRoles(seats: readonly EffectiveSeat[]): string {
  const lines: string[] = ["seat\tkind\tsource\tmodel"];
  for (const seat of seats) {
    const kind = seat.automatic ? "automatic" : "callable";
    const model =
      seat.selection === undefined ? "-" : formatModelSpec(seat.selection);
    lines.push(`${seat.seat}\t${kind}\t${seat.source}\t${model}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderConfig(config: PublicCliConfig): string {
  const lines: string[] = ["seat\tmodel"];
  const keys = Object.keys(config.seats) as (keyof typeof config.seats)[];
  if (keys.length === 0) {
    lines.push("(empty)");
  } else {
    for (const seat of keys.sort()) {
      const selection = config.seats[seat];
      if (selection === undefined) continue;
      lines.push(`${seat}\t${formatModelSpec(selection)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runConfigCommand(
  args: readonly string[],
  home: string,
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args[0] === "get" || args[0] === "list" || args[0] === "show") {
    const config = await loadPublicCliConfig(home);
    if (args[0] === "get" && args[1] !== undefined) {
      if (!isPublicConfigurableSeat(args[1])) {
        throw new CliUsageError(`unknown configurable seat: ${args[1]}`);
      }
      const selection = config.seats[args[1]];
      if (selection === undefined) {
        io.stdout(`${args[1]}\t(unconfigured)\n`);
      } else {
        io.stdout(`${args[1]}\t${formatModelSpec(selection)}\n`);
      }
      return 0;
    }
    io.stdout(renderConfig(config));
    return 0;
  }

  if (args[0] === "set") {
    if (args.length < 3) {
      throw new CliUsageError(
        "usage: ak-role config set <seat> <provider/model:thinking>",
      );
    }
    // Bulk: repeated seat spec pairs after `set`
    const pairs = args.slice(1);
    if (pairs.length % 2 !== 0) {
      throw new CliUsageError(
        "config set requires seat/spec pairs: ak-role config set <seat> <spec> [<seat> <spec> ...]",
      );
    }
    let config = await loadPublicCliConfig(home);
    for (let i = 0; i < pairs.length; i += 2) {
      const seat = pairs[i]!;
      const spec = pairs[i + 1]!;
      if (!isPublicConfigurableSeat(seat)) {
        throw new CliUsageError(`unknown configurable seat: ${seat}`);
      }
      config = setPersistentSeatConfig(config, seat, parseModelSpec(spec));
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config));
    return 0;
  }

  throw new CliUsageError(`unknown config subcommand: ${args[0]}`);
}

export async function runAkRole(
  argv: readonly string[],
  env: CliEnv,
): Promise<CliResult> {
  const io = env.io ?? defaultIo();
  const home = resolveHome(env);

  try {
    // Select the installed package identity once, before any role-owned Skill,
    // runtime entry, activation argv, or invocation provenance is derived.
    env = { ...env, packageRoot: await realpath(env.packageRoot) };
    const parsed = parseArgv(argv);

    if (
      parsed.help ||
      parsed.command === undefined ||
      parsed.command === "help"
    ) {
      // Layered help: `help <topic>` still derives from the same typed registry.
      if (parsed.command === "help" && parsed.args[0] !== undefined) {
        const topic = parsed.args[0];
        const caps = listHelpCapabilities();
        const match = caps.find((cap) => cap.name === topic);
        if (match === undefined) {
          throw new CliUsageError(`unknown help topic: ${topic}`);
        }
        if (match.kind === "support") {
          io.stdout(`command\t${match.name}\tkind\tsupport\n`);
        } else {
          io.stdout(
            `command\t${match.name}\tkind\trole\tphases\t${match.phases
              .map((p) => (p === null ? "none" : p))
              .join(",")}\tdefault\t${match.defaultPhase ?? "none"}\n`,
          );
        }
        return { exitCode: 0 };
      }
      io.stdout(renderHelp());
      return { exitCode: 0 };
    }

    if (parsed.command === "roles") {
      if (parsed.args.length > 0) {
        throw new CliUsageError("roles takes no arguments");
      }
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ??
        (await loadCredentialProviders(resolveAgentDir(env, home)));
      const seats = effectiveSeatConfigurations(
        config,
        credentials,
        invocationFromParsed(parsed),
      );
      io.stdout(renderRoles(seats));
      return { exitCode: 0 };
    }

    if (parsed.command === "config") {
      return { exitCode: await runConfigCommand(parsed.args, home, io) };
    }

    // Resume reopens an exact Role run after a typed HTTP 429 (#108/#109).
    // Seat and dispatch follow the durable admitted role (role-correct continuation).
    if (parsed.command === "resume") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const resumeRunId = parsed.args[0];
      const resumeRole =
        resumeRunId === undefined || resumeRunId.trim() === ""
          ? undefined
          : await peekRoleRunRole(home, resumeRunId);
      if (resumeRole === "collector") {
        throw new CliUsageError(
          "collector role runs are one-shot and cannot be resumed",
        );
      }
      if (resumeRole === "doctor") {
        throw new CliUsageError(
          "doctor role runs are one-shot and cannot be resumed",
        );
      }
      const resumeSeatRole =
        resumeRole === "coder"
          ? "coder"
          : resumeRole === "fixer"
            ? "fixer"
            : resumeRole === "reviewer"
              ? "reviewer"
              : resumeRole === "merger"
                ? "merger"
                : "judge";
      // Temporary model/thinking override for this resume only — never persists.
      const seat = resolveEffectiveSeat(
        config,
        resumeSeatRole,
        credentials,
        invocationFromParsed(parsed),
      );
      if (resumeRole === "coder") {
        const result = await runPublicCoderResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...(env.correlationId === undefined
              ? {}
              : { correlationId: env.correlationId }),
            ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
            ...(seat.selection === undefined ? {} : { model: seat.selection }),
            ...(env.coderExtraPiArgs === undefined
              ? {}
              : { extraPiArgs: env.coderExtraPiArgs }),
            ...(env.coderTimeoutMs === undefined
              ? {}
              : { timeoutMs: env.coderTimeoutMs }),
          },
          io,
        );
        return {
          exitCode: result.exitCode,
          ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
        };
      }
      if (resumeRole === "fixer") {
        const result = await runPublicFixerResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...(env.correlationId === undefined
              ? {}
              : { correlationId: env.correlationId }),
            ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
            ...(seat.selection === undefined ? {} : { model: seat.selection }),
            ...(env.fixerExtraPiArgs === undefined
              ? {}
              : { extraPiArgs: env.fixerExtraPiArgs }),
            ...(env.fixerTimeoutMs === undefined
              ? {}
              : { timeoutMs: env.fixerTimeoutMs }),
          },
          io,
        );
        return {
          exitCode: result.exitCode,
          ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
        };
      }
      if (resumeRole === "reviewer") {
        const result = await runPublicReviewerResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...(env.correlationId === undefined
              ? {}
              : { correlationId: env.correlationId }),
            ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
            ...(seat.selection === undefined ? {} : { model: seat.selection }),
            ...(env.reviewerExtraPiArgs === undefined
              ? {}
              : { extraPiArgs: env.reviewerExtraPiArgs }),
            ...(env.reviewerTimeoutMs === undefined
              ? {}
              : { timeoutMs: env.reviewerTimeoutMs }),
          },
          io,
        );
        return {
          exitCode: result.exitCode,
          ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
        };
      }
      if (resumeRole === "merger") {
        const result = await runPublicMergerResume(
          parsed.args,
          {
            home,
            agentDir,
            packageRoot: env.packageRoot,
            cwd,
            credentials,
            ...(env.correlationId === undefined
              ? {}
              : { correlationId: env.correlationId }),
            ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
            ...(seat.selection === undefined ? {} : { model: seat.selection }),
            ...(env.mergerExtraPiArgs === undefined
              ? {}
              : { extraPiArgs: env.mergerExtraPiArgs }),
            ...(env.mergerTimeoutMs === undefined
              ? {}
              : { timeoutMs: env.mergerTimeoutMs }),
          },
          io,
        );
        return {
          exitCode: result.exitCode,
          ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
        };
      }
      const result = await runPublicResume(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.judgeExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.judgeExtraPiArgs }),
          ...(env.judgeTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.judgeTimeoutMs }),
        },
        io,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    if (isPublicCliSupportCommand(parsed.command)) {
      throw new CliUsageError(`unhandled support command: ${parsed.command}`);
    }

    // Judge is the first complete public Role run path (#106).
    if (parsed.command === "judge") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "judge",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicJudge(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.judgeExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.judgeExtraPiArgs }),
          ...(env.judgeTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.judgeTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.judge.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Coder public run path with package-owned TDD method (#109).
    if (parsed.command === "coder") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "coder",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicCoder(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.coderExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.coderExtraPiArgs }),
          ...(env.coderTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.coderTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.coder.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Fixer public run path with optional package-owned diagnosing-bugs (#110).
    if (parsed.command === "fixer") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "fixer",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicFixer(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.fixerExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.fixerExtraPiArgs }),
          ...(env.fixerTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.fixerTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.fixer.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Collector public run path from explicit PR + leg declarations (#112).
    if (parsed.command === "collector") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "collector",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicCollector(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.collectorExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.collectorExtraPiArgs }),
          ...(env.collectorTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.collectorTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.collector.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Reviewer public run path with package-owned adapted code-review (#111).
    if (parsed.command === "reviewer") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "reviewer",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicReviewer(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.reviewerExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.reviewerExtraPiArgs }),
          ...(env.reviewerTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.reviewerTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.reviewer.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Doctor public run path from Issue identity + optional confined runs root (#113).
    if (parsed.command === "doctor") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "doctor",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicDoctor(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.doctorExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.doctorExtraPiArgs }),
          ...(env.doctorTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.doctorTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.doctor.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Merger public run path: derive active-merge envelope + forced merge-only method (#114).
    if (parsed.command === "merger") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadPublicCliConfig(home);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "merger",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicMerger(
        parsed.args,
        {
          home,
          agentDir,
          packageRoot: env.packageRoot,
          cwd,
          credentials,
          ...(env.correlationId === undefined
            ? {}
            : { correlationId: env.correlationId }),
          ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
          ...(seat.selection === undefined ? {} : { model: seat.selection }),
          ...(env.mergerExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.mergerExtraPiArgs }),
          ...(env.mergerTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.mergerTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.merger.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // #115: every PUBLIC_CALLABLE_ROLE has a completed handler above. Unknown
    // tokens (including misspelled role names) are structural rejects.
    throw new CliUsageError(`unknown command: ${parsed.command}`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      // Non-judge structural paths share the same rejection presenter as Judge.
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    // Unrecognized outer failure: retain actual name/message identity (no wash).
    if (error instanceof Error) {
      const label =
        error.name !== "" && error.name !== "Error"
          ? `${error.name}: ${error.message}`
          : error.message;
      io.stderr(formatCliDiagnostic(label || error.name || "unrecognized exception"));
      return { exitCode: 1 };
    }
    io.stderr(formatCliDiagnostic(String(error)));
    return { exitCode: 1 };
  }
}
