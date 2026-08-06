/**
 * Public ak-role CLI dispatcher (roles / config / layered help / Judge run).
 */
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
  EXPLICIT_INTERNAL_LOAD_PROBE_ARGS,
  runExplicitInternalActivation,
  type ExplicitInternalPiRunner,
} from "./explicit-internal.ts";
import {
  parseCoderArgv,
  parseCollectorArgv,
  parseDoctorArgv,
  parseJudgeArgv,
} from "./invocation.ts";
import { runPublicCoder, runPublicCoderResume } from "./coder-run.ts";
import { runPublicCollector } from "./collector-run.ts";
import { runPublicDoctor } from "./doctor-run.ts";
import { runPublicJudge, runPublicResume } from "./judge-run.ts";
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
  while (args.length > 0) {
    const token = args.shift()!;
    if (token === "--") {
      positional.push(...args);
      break;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--model") {
      const value = args.shift();
      if (value === undefined) throw new CliUsageError("--model requires a value");
      model = value;
      continue;
    }
    if (token.startsWith("--model=")) {
      model = token.slice("--model=".length);
      continue;
    }
    if (token === "--thinking") {
      const value = args.shift();
      if (value === undefined) throw new CliUsageError("--thinking requires a value");
      thinking = parseThinking(value);
      continue;
    }
    if (token.startsWith("--thinking=")) {
      thinking = parseThinking(token.slice("--thinking=".length));
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      // Subcommands may own additional flags later; only reject unknowns at the
      // top level when they appear before any positional command is collected
      // and the command is one that does not accept free flags (enforced below).
      positional.push(token);
      continue;
    }
    positional.push(token);
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
      const resumeSeatRole = resumeRole === "coder" ? "coder" : "judge";
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
        parseJudgeArgv,
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
        parseCoderArgv,
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
        parseCollectorArgv,
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
        parseDoctorArgv,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Remaining callable roles land in later #11 children.
    const roleNames = listHelpCapabilities()
      .filter((cap) => cap.kind === "role")
      .map((cap) => cap.name);
    if ((roleNames as string[]).includes(parsed.command)) {
      const agentDir = resolveAgentDir(env, home);
      const load = await runExplicitInternalActivation({
        packageRoot: env.packageRoot,
        extraArgs: EXPLICIT_INTERNAL_LOAD_PROBE_ARGS,
        cwd: env.cwd ?? process.cwd(),
        home,
        agentDir,
        ...(env.piRunner === undefined ? {} : { runner: env.piRunner }),
      });
      if (load.timedOut || load.code !== 0) {
        io.stderr(
          `ak-role: failed to load installed role runtime for '${parsed.command}'\n`,
        );
        if (load.stderr.length > 0) {
          io.stderr(load.stderr.endsWith("\n") ? load.stderr : `${load.stderr}\n`);
        }
        return { exitCode: 1 };
      }
      io.stderr(
        `ak-role: role run for '${parsed.command}' is not available in this install slice\n`,
      );
      return { exitCode: 2 };
    }

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
