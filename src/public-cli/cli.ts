/**
 * Public ak-role CLI dispatcher (roles / config / layered help / Judge run).
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  assertLegalEngineName,
} from "../package-resources/engine-material.ts";
import {
  clearPersistentSeatConfig,
  effectiveSeatConfigurations,
  formatModelSpec,
  isEngineAxisSeat,
  isGateOfficerSeat,
  loadCredentialProviders,
  loadPublicCliConfig,
  parseModelSpec,
  resolveEffectiveSeat,
  savePublicCliConfig,
  seatModelOnly,
  setAutoResumeLimit,
  setPersistentSeatConfig,
  setPersistentSeatEngine,
  validatePublicCliConfigEngines,
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
  parseInspectorArgv,
  parseMergerArgv,
  parseNotaryArgv,
  parseReviewerArgv,
  parseAnalystArgv,
} from "./invocation.ts";
import {
  createTypedOptionConsumer,
  optionsForOwner,
  projectCommandHelp,
  projectOwnerOptions,
  PUBLIC_NAVIGATOR_HELP_NOTE,
  renderHumanOwnerOptionLines,
  type PublicOptionDefinition,
  type TypedOptionConsumer,
} from "./option-definitions.ts";
import { runPublicCoder, runPublicCoderResume } from "./coder-run.ts";
import { runPublicCollector } from "./collector-run.ts";
import { runPublicDoctor } from "./doctor-run.ts";
import { runPublicFixer, runPublicFixerResume } from "./fixer-run.ts";
import { runPublicNotary } from "./notary-run.ts";
import { runPublicInspector } from "./inspector-run.ts";
import { runPublicJudge, runPublicResume } from "./judge-run.ts";
import { runPublicMerger, runPublicMergerResume } from "./merger-run.ts";
import { runPublicReviewer, runPublicReviewerResume } from "./reviewer-run.ts";
import { runPublicAnalyst } from "./analyst-run.ts";
import {
  AUTO_RESUME_LIMIT,
  peekRoleRunRole,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";
import {
  INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  isAutomaticConfigurableSeat,
  isPublicCallableRole,
  isPublicCliSupportCommand,
  isPublicConfigurableSeat,
  listHelpCapabilities,
  type PublicCallableRole,
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
 * Sole production map: public role command → argv parser + option definitions.
 * cli handlers and help consume this table; no parallel spelling set (#342).
 */
export const PUBLIC_ROLE_ARGV = {
  judge: { parse: parseJudgeArgv, options: optionsForOwner("judge") },
  coder: { parse: parseCoderArgv, options: optionsForOwner("coder") },
  fixer: { parse: parseFixerArgv, options: optionsForOwner("fixer") },
  collector: { parse: parseCollectorArgv, options: optionsForOwner("collector") },
  doctor: { parse: parseDoctorArgv, options: optionsForOwner("doctor") },
  merger: { parse: parseMergerArgv, options: optionsForOwner("merger") },
  notary: { parse: parseNotaryArgv, options: optionsForOwner("notary") },
  inspector: { parse: parseInspectorArgv, options: optionsForOwner("inspector") },
  reviewer: { parse: parseReviewerArgv, options: optionsForOwner("reviewer") },
  /** Deterministic analysis seat (#336) — argv parse only; no LLM admission. */
  analyst: { parse: parseAnalystArgv, options: optionsForOwner("analyst") },
} as const;

/** Global public options — same typed table as role rows (#342). */
export const PUBLIC_GLOBAL_OPTIONS: readonly PublicOptionDefinition[] =
  optionsForOwner("global");

type TakenPublicGlobalFlag =
  | { flag: "help"; consume: 1 }
  | { flag: "model"; consume: 1 | 2; value: string | undefined }
  | { flag: "thinking"; consume: 1 | 2; raw: string | undefined }
  | { flag: "engine"; consume: 1 | 2; value: string | undefined };

/**
 * If `argv[index]` is a public global flag, describe its span and payload.
 * Spellings + repeatable come solely from PUBLIC_OPTION_TABLE.global via the
 * shared typed consumer (#342).
 */
function takePublicGlobalFlag(
  argv: readonly string[],
  index: number,
  options: TypedOptionConsumer,
): TakenPublicGlobalFlag | undefined {
  const tokens = argv.slice(index);
  const taken = options.takeDashed(tokens as string[]);
  if (taken === undefined) return undefined;
  const consumed = argv.length - index - tokens.length;
  if (taken.def.id === "help") {
    return { flag: "help", consume: consumed as 1 };
  }
  if (taken.def.id === "model") {
    return {
      flag: "model",
      consume: consumed as 1 | 2,
      value: taken.value,
    };
  }
  if (taken.def.id === "thinking") {
    return {
      flag: "thinking",
      consume: consumed as 1 | 2,
      raw: taken.value,
    };
  }
  if (taken.def.id === "engine") {
    return {
      flag: "engine",
      consume: consumed as 1 | 2,
      value: taken.value,
    };
  }
  return undefined;
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
  /** Extra Pi args for Notary runs (tests: faux provider). */
  notaryExtraPiArgs?: readonly string[];
  /** Override Notary role-run timeout (tests). */
  notaryTimeoutMs?: number;
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
  engine?: string;
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
  let engine: string | undefined;
  let help = false;
  const positional: string[] = [];
  const globalOptions = createTypedOptionConsumer(PUBLIC_GLOBAL_OPTIONS);

  // Global flags may appear before or after the subcommand
  // (`ak-role --model x roles` and `ak-role roles --model x`).
  // Grammar authority: shared typed consumer over PUBLIC_OPTION_TABLE.global.
  // #471: after `resume <runId>`, remaining argv is the opaque message segment
  // and must not re-enter the global-option consumer — including bare `--`,
  // which is a legal opaque message token, not an argv delimiter here.
  while (args.length > 0) {
    if (positional[0] === "resume" && positional.length >= 2) {
      positional.push(...args);
      break;
    }
    if (args[0] === "--") {
      args.shift();
      positional.push(...args);
      break;
    }
    const taken = takePublicGlobalFlag(args, 0, globalOptions);
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
      if (taken.flag === "thinking") {
        if (taken.raw === undefined) {
          throw new CliUsageError("--thinking requires a value");
        }
        thinking = parseThinking(taken.raw);
        args.splice(0, taken.consume);
        continue;
      }
      if (taken.flag === "engine") {
        if (taken.value === undefined) {
          throw new CliUsageError("--engine requires a value");
        }
        engine = taken.value;
        args.splice(0, taken.consume);
        continue;
      }
      // Exhaustive for known global flags; unknown id is a table bug.
      throw new CliUsageError(`unhandled global option: ${String((taken as { flag: string }).flag)}`);
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
    ...(engine === undefined ? {} : { engine }),
    help,
  };
}

/**
 * Unique public resume request parser (#471).
 * One optional argv after runId is the opaque message; no further positionals.
 */
function parseResumeRequest(args: readonly string[]): PublicResumeRequest {
  const runId = args[0];
  if (runId === undefined || runId.trim() === "" || runId.startsWith("-")) {
    throw new CliUsageError("usage: ak-role resume <runId> [message]");
  }
  if (args.length > 2) {
    throw new CliUsageError("usage: ak-role resume <runId> [message]");
  }
  if (args.length === 2) {
    return { runId, message: args[1]! };
  }
  return { runId };
}

function invocationFromParsed(parsed: ParsedGlobal): InvocationModelOverride | undefined {
  if (
    parsed.model === undefined &&
    parsed.thinking === undefined &&
    parsed.engine === undefined
  ) {
    return undefined;
  }
  return {
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
    ...(parsed.engine === undefined ? {} : { engine: parsed.engine }),
  };
}

function requireLegalEngineName(name: string): string {
  try {
    return assertLegalEngineName(name);
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

/**
 * Persistent engine axis gate (#391 E1): PUBLIC_CALLABLE_ROLES only.
 * Automatic seats are configurable for model but have no independent activation path.
 */
function requireEngineAxisSeat(
  seat: string,
  verb: "set-engine" | "unset-engine",
): asserts seat is PublicCallableRole {
  if (isAutomaticConfigurableSeat(seat)) {
    throw new CliUsageError(
      `config ${verb} refuses ${seat}: no independent activation path; storing would be silently ineffective`,
    );
  }
  if (!isEngineAxisSeat(seat)) {
    throw new CliUsageError(`unknown engine-axis seat: ${seat}`);
  }
}

/** Single seat.engine → run-options projection (#391 E2). */
function projectSeatEngine(
  seat: Readonly<{ engine?: string }>,
): { engine: string } | Record<PropertyKey, never> {
  return seat.engine === undefined ? {} : { engine: seat.engine };
}

function loadAndValidateConfig(
  home: string,
  packageRoot: string,
): Promise<PublicCliConfig> {
  return loadPublicCliConfig(home).then((config) => {
    try {
      validatePublicCliConfigEngines(config, packageRoot);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    return config;
  });
}

/** Typed facts used by help presentation — not layout. */
export function helpDocument() {
  return {
    executable: "ak-role",
    capabilities: listHelpCapabilities(),
    internalEntrypoint: INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
    /** #342 structured global options from the sole option table. */
    globalOptions: projectOwnerOptions("global"),
  };
}

/** Structured help facts for one public command/role (#342). */
export function helpDocumentForCommand(command: string) {
  if (command === "global") {
    return {
      command: "global" as const,
      kind: "global" as const,
      options: projectOwnerOptions("global"),
    };
  }
  if (command in PUBLIC_ROLE_ARGV) {
    const owner = command as keyof typeof PUBLIC_ROLE_ARGV;
    return {
      command: owner,
      kind: owner === "analyst" ? ("deterministic" as const) : ("role" as const),
      options: projectOwnerOptions(owner),
    };
  }
  return undefined;
}

/** Append USAGE + EXAMPLES blocks from the sole public help-copy owner. */
function appendUsageAndExamples(
  lines: string[],
  topic: string,
): void {
  const facts = projectCommandHelp(topic);
  if (facts === undefined) return;
  lines.push("", "USAGE");
  for (const line of facts.usage) {
    lines.push(`  ${line}`);
  }
  if (facts.examples.length > 0) {
    lines.push("", "EXAMPLES");
    for (const example of facts.examples) {
      lines.push(`  ${example}`);
    }
  }
}

function renderHelp(): string {
  const doc = helpDocument();
  // "top" is a required PUBLIC_COMMAND_HELP topic — no fallback prose (#412/397-F3).
  const top = projectCommandHelp("top")!;
  const lines: string[] = [
    `ak-role — ${top.summary}`,
  ];
  appendUsageAndExamples(lines, "top");
  lines.push("", PUBLIC_NAVIGATOR_HELP_NOTE);
  lines.push("", "Support commands:");
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
  lines.push("", "Deterministic commands:");
  for (const cap of doc.capabilities) {
    if (cap.kind === "deterministic") {
      lines.push(`  ${cap.name}`);
    }
  }
  lines.push("", "OPTIONS");
  lines.push(...renderHumanOwnerOptionLines("global"));
  lines.push(
    "",
    "Role options: ak-role help <command>",
    "Persistent config: ak-role config set <seat> <provider/model[:thinking]> | unset <gatekeeper|inspector|notary>",
    "Persistent engine (callable roles): ak-role config set-engine <seat> <name> | unset-engine <seat>",
    "Effective seats: ak-role roles",
  );
  return `${lines.join("\n")}\n`;
}

function renderCommandHelp(command: string): string | undefined {
  const caps = listHelpCapabilities();
  const match = caps.find((cap) => cap.name === command);
  if (match === undefined) return undefined;
  const facts = projectCommandHelp(command);
  const lines: string[] = [];
  if (facts !== undefined) {
    lines.push(`ak-role ${facts.command} — ${facts.summary}`);
  } else if (match.kind === "support") {
    lines.push(`ak-role ${match.name}`);
  } else if (match.kind === "deterministic") {
    lines.push(`ak-role ${match.name}`);
  } else {
    lines.push(`ak-role ${match.name}`);
  }
  appendUsageAndExamples(lines, command);
  // listHelpCapabilities never yields "global"; only role owners carry OPTIONS (#412/397-F3).
  if (command in PUBLIC_ROLE_ARGV) {
    const owner = command as keyof typeof PUBLIC_ROLE_ARGV;
    lines.push("", "OPTIONS");
    lines.push(...renderHumanOwnerOptionLines(owner));
  }
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

function renderPersistentSeatModel(selection: {
  provider?: string;
  model?: string;
  thinking?: PublicThinkingLevel;
}): string {
  const model = seatModelOnly(selection);
  return model === undefined ? "-" : formatModelSpec(model);
}

function renderConfig(config: PublicCliConfig): string {
  const lines: string[] = ["seat\tmodel\tengine"];
  const keys = Object.keys(config.seats) as (keyof typeof config.seats)[];
  if (keys.length === 0) {
    lines.push("(empty)");
  } else {
    for (const seat of keys.sort()) {
      const selection = config.seats[seat];
      if (selection === undefined) continue;
      const engine = selection.engine === undefined ? "-" : selection.engine;
      lines.push(`${seat}\t${renderPersistentSeatModel(selection)}\t${engine}`);
    }
  }
  // #422: show the effective auto-resume ceiling (configured value or default).
  lines.push(`autoResumeLimit\t${config.autoResumeLimit ?? AUTO_RESUME_LIMIT}`);
  return `${lines.join("\n")}\n`;
}

async function runConfigCommand(
  args: readonly string[],
  home: string,
  packageRoot: string,
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args[0] === "get" || args[0] === "list" || args[0] === "show") {
    const config = await loadAndValidateConfig(home, packageRoot);
    if (args[0] === "get" && args[1] !== undefined) {
      if (!isPublicConfigurableSeat(args[1])) {
        throw new CliUsageError(`unknown configurable seat: ${args[1]}`);
      }
      const selection = config.seats[args[1]];
      if (selection === undefined) {
        io.stdout(`${args[1]}\t(unconfigured)\n`);
      } else {
        const engine =
          selection.engine === undefined ? "-" : selection.engine;
        io.stdout(
          `${args[1]}\t${renderPersistentSeatModel(selection)}\t${engine}\n`,
        );
      }
      return 0;
    }
    io.stdout(renderConfig(config));
    return 0;
  }

  if (args[0] === "set") {
    if (args.length < 3) {
      throw new CliUsageError(
        "usage: ak-role config set <seat> <provider/model[:thinking]>",
      );
    }
    // Bulk: repeated seat spec pairs after `set`
    const pairs = args.slice(1);
    if (pairs.length % 2 !== 0) {
      throw new CliUsageError(
        "config set requires seat/spec pairs: ak-role config set <seat> <spec> [<seat> <spec> ...]",
      );
    }
    let config = await loadAndValidateConfig(home, packageRoot);
    for (let i = 0; i < pairs.length; i += 2) {
      const seat = pairs[i]!;
      const spec = pairs[i + 1]!;
      if (!isPublicConfigurableSeat(seat)) {
        throw new CliUsageError(`unknown configurable seat: ${seat}`);
      }
      // #384: persistent seat config shares the invocation model grammar.
      // Bare provider/model stores as-is; :thinking suffix still required only when colon present.
      config = setPersistentSeatConfig(config, seat, parseModelSpec(spec));
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config));
    return 0;
  }

  // #453: clear gate officer model override only (engine axis preserved).
  if (args[0] === "unset") {
    if (args.length !== 2) {
      throw new CliUsageError(
        "usage: ak-role config unset <gatekeeper|inspector|notary>",
      );
    }
    const seat = args[1]!;
    if (!isGateOfficerSeat(seat)) {
      throw new CliUsageError(
        `config unset serves gate officer overrides only (gatekeeper|inspector|notary); got ${seat}`,
      );
    }
    const config = clearPersistentSeatConfig(
      await loadAndValidateConfig(home, packageRoot),
      seat,
    );
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config));
    return 0;
  }

  if (args[0] === "set-engine") {
    if (args.length !== 3) {
      throw new CliUsageError(
        "usage: ak-role config set-engine <seat> <name>",
      );
    }
    const seat = args[1]!;
    const name = args[2]!;
    requireEngineAxisSeat(seat, "set-engine");
    requireLegalEngineName(name);
    let config = await loadAndValidateConfig(home, packageRoot);
    try {
      config = setPersistentSeatEngine(config, seat, name);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config));
    return 0;
  }

  if (args[0] === "unset-engine") {
    if (args.length !== 2) {
      throw new CliUsageError(
        "usage: ak-role config unset-engine <seat>",
      );
    }
    const seat = args[1]!;
    requireEngineAxisSeat(seat, "unset-engine");
    let config = await loadAndValidateConfig(home, packageRoot);
    try {
      config = setPersistentSeatEngine(config, seat, undefined);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config));
    return 0;
  }

  // #422: standalone verb per the set-engine/unset-engine precedent — the
  // existing `config set` grammar stays strictly even-position seat/spec pairs.
  if (args[0] === "set-auto-resume-limit") {
    if (args.length !== 2) {
      throw new CliUsageError(
        "usage: ak-role config set-auto-resume-limit <N>",
      );
    }
    const raw = args[1]!;
    if (!/^[0-9]+$/.test(raw)) {
      throw new CliUsageError(
        `auto-resume limit must be a non-negative integer, got ${raw}`,
      );
    }
    // #422 fidelity boundary (not an upper bound — ADR 0035 stays intact): the
    // persisted representation is a JS number, and Number() silently rounds
    // integers beyond 2^53-1 (e.g. 9007199254740993 → 9007199254740992). Refuse
    // loudly instead of persisting a different N; every exactly-representable
    // non-negative integer remains legal. The regex above guarantees pure
    // digits, so BigInt(raw) has no leading-zero ambiguity.
    const converted = Number(raw);
    if (!Number.isFinite(converted) || BigInt(converted) !== BigInt(raw)) {
      throw new CliUsageError(
        `auto-resume limit ${raw} is not exactly representable as a number; refusing to silently round the value`,
      );
    }
    let config = await loadAndValidateConfig(home, packageRoot);
    config = setAutoResumeLimit(config, converted);
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
    // Invocation --engine rejects at the call-request seam (not role submission).
    // #356 / #378 / #391: engine axis is every callable role (not resume / support).
    if (parsed.engine !== undefined) {
      requireLegalEngineName(parsed.engine);
      if (
        !parsed.help &&
        parsed.command !== undefined &&
        parsed.command !== "help" &&
        !isPublicCallableRole(parsed.command)
      ) {
        throw new CliUsageError(
          `engine axis is role commands only; refused command ${parsed.command}`,
        );
      }
    }

    if (
      parsed.help ||
      parsed.command === undefined ||
      parsed.command === "help"
    ) {
      // Layered help: `help <topic>` derives from the typed registry + option table (#342).
      if (parsed.command === "help" && parsed.args[0] !== undefined) {
        const topic = parsed.args[0];
        const rendered = renderCommandHelp(topic);
        if (rendered === undefined) {
          throw new CliUsageError(`unknown help topic: ${topic}`);
        }
        io.stdout(rendered);
        return { exitCode: 0 };
      }
      io.stdout(renderHelp());
      return { exitCode: 0 };
    }

    if (parsed.command === "roles") {
      if (parsed.args.length > 0) {
        throw new CliUsageError("roles takes no arguments");
      }
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
      return {
        exitCode: await runConfigCommand(parsed.args, home, env.packageRoot, io),
      };
    }

    // Resume reopens an exact Role run (#416): caller decides; session principal
    // must still exist. Seat and dispatch follow the durable admitted role.
    // #471: unique parser owns {runId, message?}; five role paths only consume it.
    if (parsed.command === "resume") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadAndValidateConfig(home, env.packageRoot);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const resumeRequest = parseResumeRequest(parsed.args);
      const resumeRole = await peekRoleRunRole(home, resumeRequest.runId);
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
          resumeRequest,
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
          resumeRequest,
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
          resumeRequest,
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
          resumeRequest,
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
        resumeRequest,
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
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
          ...projectSeatEngine(seat),
          ...(env.judgeExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.judgeExtraPiArgs }),
          ...(env.judgeTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.judgeTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
          // #422: effective auto-resume ceiling resolved once here; the loop never re-reads disk.
          ...(config.autoResumeLimit === undefined
            ? {}
            : { autoResumeLimit: config.autoResumeLimit }),
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
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
          ...projectSeatEngine(seat),
          ...(env.coderExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.coderExtraPiArgs }),
          ...(env.coderTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.coderTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
          // #422: effective auto-resume ceiling resolved once here; the loop never re-reads disk.
          ...(config.autoResumeLimit === undefined
            ? {}
            : { autoResumeLimit: config.autoResumeLimit }),
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
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
          ...projectSeatEngine(seat),
          ...(env.fixerExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.fixerExtraPiArgs }),
          ...(env.fixerTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.fixerTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
          // #422: effective auto-resume ceiling resolved once here; the loop never re-reads disk.
          ...(config.autoResumeLimit === undefined
            ? {}
            : { autoResumeLimit: config.autoResumeLimit }),
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
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
          ...projectSeatEngine(seat),
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
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
          ...projectSeatEngine(seat),
          ...(env.reviewerExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.reviewerExtraPiArgs }),
          ...(env.reviewerTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.reviewerTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
          // #422: effective auto-resume ceiling resolved once here; the loop never re-reads disk.
          ...(config.autoResumeLimit === undefined
            ? {}
            : { autoResumeLimit: config.autoResumeLimit }),
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
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
          ...projectSeatEngine(seat),
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

    // Notary public run path: source-run locator only, direct officer seat (#448).
    if (parsed.command === "notary") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadAndValidateConfig(home, env.packageRoot);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "notary",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicNotary(
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
          ...projectSeatEngine(seat),
          ...(env.notaryExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.notaryExtraPiArgs }),
          ...(env.notaryTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.notaryTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
        },
        io,
        PUBLIC_ROLE_ARGV.notary.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    if (parsed.command === "inspector") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadAndValidateConfig(home, env.packageRoot);
      const credentials = env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(config, "inspector", credentials, invocationFromParsed(parsed));
      const result = await runPublicInspector(parsed.args, {
        home, agentDir, packageRoot: env.packageRoot, cwd, credentials,
        ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
        ...(env.piRunner === undefined ? {} : { piRunner: env.piRunner }),
        ...(seat.selection === undefined ? {} : { model: seat.selection }),
        ...projectSeatEngine(seat),
        ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
      }, io, PUBLIC_ROLE_ARGV.inspector.parse);
      return { exitCode: result.exitCode, ...(result.terminal === undefined ? {} : { terminal: result.terminal }) };
    }

    // Merger public run path: derive active-merge envelope + forced merge-only method (#114).
    if (parsed.command === "merger") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadAndValidateConfig(home, env.packageRoot);
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
          ...projectSeatEngine(seat),
          ...(env.mergerExtraPiArgs === undefined
            ? {}
            : { extraPiArgs: env.mergerExtraPiArgs }),
          ...(env.mergerTimeoutMs === undefined
            ? {}
            : { timeoutMs: env.mergerTimeoutMs }),
          ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
          // #422: effective auto-resume ceiling resolved once here; the loop never re-reads disk.
          ...(config.autoResumeLimit === undefined
            ? {}
            : { autoResumeLimit: config.autoResumeLimit }),
        },
        io,
        PUBLIC_ROLE_ARGV.merger.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Analyst public run path: deterministic analysis seat (#336 issue / #337 sweep).
    // Not an LLM PUBLIC_CALLABLE_ROLE — registered only on PUBLIC_ROLE_ARGV (#176).
    if (parsed.command === "analyst") {
      const result = await runPublicAnalyst(
        parsed.args,
        { home },
        io,
        PUBLIC_ROLE_ARGV.analyst.parse,
      );
      return { exitCode: result.exitCode };
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
