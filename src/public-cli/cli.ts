import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import { piDurablePrincipalAuthority } from "../pi/durable-principal.ts";
/**
 * Public ak-role CLI dispatcher (roles / config / layered help / Judge run).
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { packageMachineHome } from "../activation-ledger-topology.ts";
import {
  assertLegalEngineModel,
  assertLegalEngineName,
  pickEngineAxis,
} from "../package-resources/engine-material.ts";
import {
  resolveConfiguredProvinceOfficer,
  type ConfiguredProvinceOfficerResolution,
} from "../institutional-resolution.ts";
import {
  clearPersistentSeatConfig,
  effectiveSeatConfigurations,
  formatModelSpec,
  isGateOfficerSeat,
  loadCredentialProviders,
  loadPublicCliConfig,
  missingResolvedSeatModelMessage,
  parseModelSpec,
  resolveEffectiveSeat,
  resolvedSeatWithModel,
  savePublicCliConfig,
  setAutoResumeLimit,
  setPersistentSeatConfig,
  setPersistentSeatEngine,
  setPersistentSeatEngineModel,
  setPersistentSeatHost,
  validatePublicCliConfigAxes,
  type CredentialProviders,
  type EffectiveSeat,
  type InvocationModelOverride,
  type PublicCliConfig,
} from "./config.ts";
import {
  loadHostProvidersTable,
  projectHostFacingProvider,
  renderHostProvidersTable,
} from "./host-providers.ts";
import { packagedModelParent } from "../packaged-role-registry.ts";
import { seatModelOnly } from "./registry.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { CliIo } from "./cli-io.ts";
import type { PostAdmissionEnv } from "./post-admission.ts";
import type { RoleTurnHost } from "../host-contracts.ts";
import { appendPiSessionCustomEntry } from "../pi/role-turn-host.ts";
import {
  composeRoleTurnHostAdapters,
  formatHostSelectionFailure,
  HostSelectionError,
  selectRoleTurnHost,
  type HostSelectionFailure,
  type NamedRoleTurnHostAdapter,
} from "./role-turn-host-resolution.ts";
import {
  parseAnalystArgv,
  parsePublicSeatArgv,
  type PublicSeatArgvOwner,
  type PublicSeatParse,
} from "./invocation.ts";
import {
  createTypedOptionConsumer,
  optionsForOwner,
  projectCommandHelp,
  projectOwnerOptions,
  PUBLIC_NAVIGATOR_HELP_NOTE,
  PUBLIC_ROLE_OPTION_OWNERS,
  renderHumanOwnerOptionLines,
  type PublicOptionDefinition,
  type PublicRoleOptionOwner,
  type TypedOptionConsumer,
} from "./option-definitions.ts";
import { continueParentAfterChild, runPublicInstructionSeat, runPublicInstructionSeatResume } from "./instruction-seat-run.ts";
import { latestPayloadEscalated } from "./countersign-run.ts";
import { runPublicAnalyst } from "./analyst-run.ts";
import {
  AUTO_RESUME_LIMIT,
  peekRoleRunRole,
  type PublicResumeRequest,
} from "./run-lifecycle.ts";

import {
  INTERNAL_ROLE_ENTRYPOINT_RELATIVE,
  PUBLIC_CALLABLE_ROLES,
  isPublicCallableRole,
  isPublicCliSupportCommand,
  isPublicConfigurableSeat,
  type PublicConfigurableSeat,
  listHelpCapabilities,
  type PublicCallableRole,
  type PublicThinkingLevel,
} from "./registry.ts";
import {
  formatCliDiagnostic,
  formatErrorCauseDetail,
  presentStructuralRejection,
} from "./settlement.ts";
import type { TerminalResult } from "./terminal.ts";

export {
  buildExplicitInternalActivationArgs,
  resolveInternalRoleEntrypoint,
} from "../pi/role-turn-host.ts";
export { CliUsageError } from "./cli-errors.ts";
export type { CliIo } from "./cli-io.ts";

/**
 * Sole production map: public role command → one argv parse + that owner's option row.
 * Seat option values are assigned in parsePublicSeatArgv. Analyst stays deterministic.
 */
function publicSeatArgv(owner: PublicSeatArgvOwner) {
  return {
    parse: (args: readonly string[]) => parsePublicSeatArgv(owner, args),
    options: optionsForOwner(owner),
  };
}

type PublicRoleArgvTable = {
  [K in PublicRoleOptionOwner]: K extends "analyst"
    ? {
        readonly parse: typeof parseAnalystArgv;
        readonly options: readonly PublicOptionDefinition[];
      }
    : ReturnType<typeof publicSeatArgv>;
};

/**
 * One argv row per public owner. Seats come from PUBLIC_ROLE_OPTION_OWNERS
 * (composition-root roles plus the deterministic analyst command).
 */
export const PUBLIC_ROLE_ARGV = Object.fromEntries(
  PUBLIC_ROLE_OPTION_OWNERS.map((owner) => [
    owner,
    owner === "analyst"
      ? { parse: parseAnalystArgv, options: optionsForOwner("analyst") }
      : publicSeatArgv(owner),
  ]),
) as PublicRoleArgvTable;

/** Global public options — same typed table as role rows (#342). */
export const PUBLIC_GLOBAL_OPTIONS: readonly PublicOptionDefinition[] =
  optionsForOwner("global");

type TakenPublicGlobalFlag =
  | { flag: "help"; consume: 1 }
  | { flag: "model"; consume: 1 | 2; value: string | undefined }
  | { flag: "thinking"; consume: 1 | 2; raw: string | undefined }
  | { flag: "engine"; consume: 1 | 2; value: string | undefined }
  | { flag: "host"; consume: 1 | 2; value: string | undefined };

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
  if (taken.def.id === "engine" || taken.def.id === "host") {
    return {
      flag: taken.def.id,
      consume: consumed as 1 | 2,
      value: taken.value,
    };
  }
  return undefined;
}

export type { HostSelectionFailure, NamedRoleTurnHostAdapter };

export type CliEnv = {
  home?: string;
  /** Host durable-principal authority; production uses the Pi adapter. */
  principalAuthority?: DurablePrincipalAuthority;
  agentDir?: string;
  /** Process cwd for any Pi subprocess owned by ak-role. */
  cwd?: string;
  packageRoot: string;
  credentials?: CredentialProviders;
  io?: CliIo;
  /**
   * Injectable host-neutral turn host (tests). Production composes the Pi
   * adapter once per dispatch from packageRoot + extraPiArgs/timeout.
   */
  roleTurnHost?: RoleTurnHost;
  /** Composition-root-owned unique named adapter table. */
  hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  /** Optional caller correlation id (#78 host channel). */
  correlationId?: string;
  /** Extra Pi args for the dispatched public seat (tests: faux provider). */
  extraPiArgs?: readonly string[];
  /** Override the dispatched public seat's role-run timeout (tests). */
  timeoutMs?: number;
  createRunId?: () => string;
  /**
   * #724: set by the `new` support verb before role dispatch; seat runners
   * skip same-ticket auto-resume. Not a public flag — the verb is the choice.
   */
  freshSummons?: true;
  /** Typed ticket already on this summons. Not a public argv flag. */
  boundTicketNumber?: number;
  /**
   * #855: process-level cancel (SIGTERM/SIGINT/SIGHUP). Nested turns receive
   * the same signal so hosts can gracefully stop children.
   */
  signal?: AbortSignal;
};



type RoleEnvironmentOptions = {
  role: PublicCallableRole;
  home: string;
  agentDir: string;
  cwd: string;
  credentials?: CredentialProviders;
  seat: EffectiveSeat;
  config?: PublicCliConfig;
};

function createRoleEnvironment(
  env: CliEnv,
  options: RoleEnvironmentOptions,
  /** #178: after host selection, before missing-model — structural argv parse once. */
  afterHost?: () => void,
) {
  const role = options.role;
  const extraPiArgs = env.extraPiArgs;
  const timeoutMs = env.timeoutMs;

  // #617/#178/#788/#840: host first, then model; nested child seat selects own host.
  const hostAdapters = composeRoleTurnHostAdapters(
    {
      packageRoot: env.packageRoot,
      ...(env.roleTurnHost === undefined ? {} : { roleTurnHost: env.roleTurnHost }),
      ...(env.hostAdapters === undefined ? {} : { hostAdapters: env.hostAdapters }),
      ...(extraPiArgs === undefined ? {} : { extraPiArgs }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    env.principalAuthority!,
  );
  const roleTurnHost = selectRoleTurnHost(hostAdapters, {
    role,
    seat: options.seat,
  });
  // #178: host → argv (afterHost) → missing-model → provider projection.
  afterHost?.();
  const seatWithModel = resolvedSeatWithModel(options.seat);
  if (seatWithModel === undefined) {
    // Direct CLI has --model; dual remediation is intentional here (#178 / #916).
    throw new CliUsageError(
      missingResolvedSeatModelMessage(options.seat.seat, "invocation-or-config"),
    );
  }
  const hostFacingSelection = projectHostFacingProvider(
    seatWithModel.selection,
    seatWithModel.host,
    loadHostProvidersTable(options.home),
    options.home,
  );
  return {
    home: options.home,
    principalAuthority: env.principalAuthority!,
    agentDir: options.agentDir,
    sessionAppender: appendPiSessionCustomEntry,
    packageRoot: env.packageRoot,
    roleTurnHost,
    hostAdapters,
    cwd: options.cwd,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
    ...(hostFacingSelection === undefined ? {} : { model: hostFacingSelection }),
    ...projectSeatEngine(options.seat),
    ...projectSeatHost(options.seat),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
    ...(options.config?.autoResumeLimit === undefined
      ? {}
      : { autoResumeLimit: options.config.autoResumeLimit }),
    ...(env.freshSummons === true ? { freshSummons: true as const } : {}),
    ...(env.boundTicketNumber === undefined
      ? {}
      : { boundTicketNumber: env.boundTicketNumber }),
    ...(env.signal === undefined ? {} : { signal: env.signal }),
  };
}

/**
 * #178 single spine: resolve seat → host select → argv parse once → missing-model → run.
 * Keeps host-unregistered ahead of bad argv and missing-model.
 */
async function dispatchPublicRoleCommand<TParsed>(
  env: CliEnv,
  home: string,
  io: CliIo,
  parsed: ParsedGlobal,
  role: PublicCallableRole,
  parse: (args: readonly string[]) => TParsed,
  run: (
    args: readonly string[],
    roleEnv: ReturnType<typeof createRoleEnvironment>,
    parseOnce: () => TParsed,
  ) => Promise<{ exitCode: number; terminal?: TerminalResult }>,
): Promise<CliResult> {
  const agentDir = resolveAgentDir(env, home);
  const cwd = env.cwd ?? process.cwd();
  const config = await loadAndValidateConfig(home, env.packageRoot);
  const credentials =
    env.credentials ?? (await loadCredentialProviders(agentDir));
  const seat = resolveEffectiveSeat(
    config,
    role,
    credentials,
    invocationFromParsed(parsed),
  );
  let parsedRoleArgv!: TParsed;
  const result = await run(
    parsed.args,
    createRoleEnvironment(
      env,
      { role, home, agentDir, cwd, credentials, seat, config },
      () => {
        parsedRoleArgv = parse(parsed.args);
      },
    ),
    () => parsedRoleArgv,
  );
  return {
    exitCode: result.exitCode,
    ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
  };
}

export type CliResult = {
  exitCode: number;
  /** Settled Terminal when an admitted Role run produced one (programmatic/tests). */
  terminal?: TerminalResult;
  hostFailure?: HostSelectionFailure;
};

function cliResultFromRoleRun(result: {
  exitCode: number;
  terminal?: TerminalResult;
}): CliResult {
  return {
    exitCode: result.exitCode,
    ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
  };
}

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
  return env.home ?? packageMachineHome();
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
  host?: string;
  help: boolean;
};

function parseThinking(value: string): PublicThinkingLevel {
  // #683: opaque pass-through — no local whitelist.
  return value;
}

function parseArgv(argv: readonly string[]): ParsedGlobal {
  const args = [...argv];
  let model: string | undefined;
  let thinking: PublicThinkingLevel | undefined;
  let engine: string | undefined;
  let host: string | undefined;
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
      if (taken.flag === "engine" || taken.flag === "host") {
        if (taken.value === undefined || taken.value.trim() === "") {
          throw new CliUsageError(`--${taken.flag} requires a value`);
        }
        if (taken.flag === "engine") engine = taken.value;
        else host = taken.value;
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
    ...(host === undefined ? {} : { host }),
    help,
  };
}

/**
 * Unique public resume request parser (#471).
 * One optional argv after runId is the opaque message; no further positionals.
 */
const RESUME_USAGE_ERROR =
  "usage: ak-role resume <runId> [message] (put --model/--thinking/--host/--engine before <runId>; the one argv after <runId> is the opaque message, #471)";

function parseResumeRequest(args: readonly string[]): PublicResumeRequest {
  const runId = args[0];
  if (runId === undefined || runId.trim() === "" || runId.startsWith("-")) {
    throw new CliUsageError(RESUME_USAGE_ERROR);
  }
  if (args.length > 2) {
    throw new CliUsageError(RESUME_USAGE_ERROR);
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
    parsed.engine === undefined &&
    parsed.host === undefined
  ) {
    return undefined;
  }
  return {
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
    ...(parsed.engine === undefined ? {} : { engine: parsed.engine }),
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
  };
}

function requireLegalEngineModel(model: string): string {
  try {
    return assertLegalEngineModel(model);
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
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

/** Callable seats own persistent call axes (checked against the callable predicate). */
function requireCallableSeat(
  seat: string,
  axis: "engine" | "host",
  verb:
    | "set-engine"
    | "unset-engine"
    | "set-engine-model"
    | "unset-engine-model"
    | "set-host"
    | "unset-host",
): asserts seat is PublicCallableRole {
  if (!isPublicCallableRole(seat)) {
    throw new CliUsageError(`unknown ${axis}-axis seat: ${seat}`);
  }
}

/** Single seat engine axis → run-options projection (#391 E2 / #883). */
function projectSeatEngine(
  seat: Readonly<{ engine?: string; engineModel?: string }>,
): { engine?: string; engineModel?: string } {
  return pickEngineAxis(seat);
}

/** Single seat.host → run-options projection (#595 / #617). */
function projectSeatHost(
  seat: Readonly<{ host: string }>,
): { host: string } {
  return { host: seat.host };
}

function loadAndValidateConfig(
  home: string,
  packageRoot: string,
): Promise<PublicCliConfig> {
  return loadPublicCliConfig(home).then((config) => {
    try {
      validatePublicCliConfigAxes(config, packageRoot);
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
    "Persistent engine (callable roles): ak-role config set-engine <seat> <name> [model] | unset-engine <seat> | set-engine-model <seat> <model> | unset-engine-model <seat>",
    "Persistent host (callable roles): ak-role config set-host <seat> <name> | unset-host <seat>",
    "Host providers: ~/.ak-roles/host-providers.json (owner-edited; table > unique host directory > fail)",
    "Model resolution: --model → persistent seat → officer inherit (#620); still none → error (#178)",
    "Host resolution: --host → persistent seat host → pi (resume uses the same order; #617)",
    "Resume flag position: --model/--thinking/--host/--engine go before <runId> (before `resume` or between `resume` and <runId>); the one argv after <runId> is always the opaque message, never a flag (#471)",
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
  const lines: string[] = ["seat\tsource\tmodel"];
  for (const seat of seats) {
    const model =
      seat.selection === undefined ? "-" : formatModelSpec(seat.selection);
    lines.push(`${seat.seat}\t${seat.source}\t${model}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * #620 typed config display row. Non-subordinate seats stay on the persistent
 * disk face; notary/inspector may surface inherit-gatekeeper.
 * Presentation formats these fields; tests assert the projection, not TSV.
 * source reuses the institutional authority domain — no parallel union.
 */
export type ConfigDisplaySeat = {
  readonly seat: PublicConfigurableSeat;
  readonly source: ConfiguredProvinceOfficerResolution["source"];
  readonly selection?: EffectiveSeat["selection"];
  readonly engine?: string;
  readonly engineModel?: string;
  readonly host?: string;
};

function diskAxes(disk: PublicCliConfig["seats"][PublicConfigurableSeat]): {
  engine?: string;
  engineModel?: string;
  host?: string;
} {
  return {
    ...pickEngineAxis(disk ?? {}),
    ...(disk?.host === undefined ? {} : { host: disk.host }),
  };
}

/**
 * Single-seat config projection (#620).
 * - notary/inspector: institutional authority result (own > gatekeeper)
 * - all other seats: disk model only (persistent face; no package fill-in, #178)
 */
export function projectConfigSeatDisplay(
  config: PublicCliConfig,
  seat: PublicConfigurableSeat,
): ConfigDisplaySeat {
  const disk = config.seats[seat];
  if (packagedModelParent(seat) !== undefined) {
    const resolved = resolveConfiguredProvinceOfficer(config, seat);
    return {
      seat,
      source: resolved.source,
      ...(resolved.selection === undefined ? {} : { selection: resolved.selection }),
      ...diskAxes(disk),
    };
  }
  const own = seatModelOnly(disk);
  if (own !== undefined) {
    return { seat, source: "persistent", selection: own, ...diskAxes(disk) };
  }
  if (disk === undefined) {
    return { seat, source: "unconfigured" };
  }
  return { seat, source: "unconfigured", ...diskAxes(disk) };
}

/**
 * Bulk config show projection (#620).
 * Disk seats only, plus notary/inspector inherit rows when gatekeeper supplies a
 * model and the subordinate has no own pin — never invent province rows from an
 * unrelated seat like coder.
 */
export function projectConfigDisplaySeats(
  config: PublicCliConfig,
): readonly ConfigDisplaySeat[] {
  const diskSeats = (Object.keys(config.seats) as PublicConfigurableSeat[]).filter(
    (seat) => isPublicConfigurableSeat(seat),
  );
  const rows = new Map<PublicConfigurableSeat, ConfigDisplaySeat>();
  for (const seat of diskSeats) {
    rows.set(seat, projectConfigSeatDisplay(config, seat));
  }
  for (const seat of PUBLIC_CALLABLE_ROLES) {
    if (packagedModelParent(seat) === undefined || rows.has(seat)) continue;
    const projected = projectConfigSeatDisplay(config, seat);
    if (projected.source === "inherit-gatekeeper") {
      rows.set(seat, projected);
    }
  }
  return [...rows.keys()].sort().map((seat) => rows.get(seat)!);
}

function renderConfigDisplaySeat(row: ConfigDisplaySeat): string {
  const model =
    row.selection === undefined ? "-" : formatModelSpec(row.selection);
  const engine = row.engine === undefined ? "-" : row.engine;
  const engineModel = row.engineModel === undefined ? "-" : row.engineModel;
  const host = row.host === undefined ? "-" : row.host;
  return `${row.seat}\t${row.source}\t${model}\t${engine}\t${engineModel}\t${host}`;
}

function renderConfig(config: PublicCliConfig, home: string): string {
  const lines: string[] = ["seat\tsource\tmodel\tengine\tengineModel\thost"];
  const rows = projectConfigDisplaySeats(config);
  if (rows.length === 0) {
    lines.push("(empty)");
  } else {
    for (const row of rows) {
      lines.push(renderConfigDisplaySeat(row));
    }
  }
  // #422: show the effective auto-resume ceiling (configured value or default).
  lines.push(`autoResumeLimit\t${config.autoResumeLimit ?? AUTO_RESUME_LIMIT}`);
  // #788: owner host-providers table as written on disk (separate file).
  const hostProvidersBlock = renderHostProvidersTable(loadHostProvidersTable(home));
  return `${lines.join("\n")}\n${hostProvidersBlock}`;
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
      io.stdout(
        `${renderConfigDisplaySeat(projectConfigSeatDisplay(config, args[1]))}\n`,
      );
      return 0;
    }
    io.stdout(renderConfig(config, home));
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
    io.stdout(renderConfig(config, home));
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
    io.stdout(renderConfig(config, home));
    return 0;
  }

  if (args[0] === "set-host" || args[0] === "unset-host") {
    const unset = args[0] === "unset-host";
    if (args.length !== (unset ? 2 : 3)) {
      throw new CliUsageError(`usage: ak-role config ${args[0]} <seat>${unset ? "" : " <name>"}`);
    }
    const seat = args[1]!;
    requireCallableSeat(seat, "host", unset ? "unset-host" : "set-host");
    let config = await loadAndValidateConfig(home, packageRoot);
    try {
      config = setPersistentSeatHost(config, seat, unset ? undefined : args[2]!);
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config, home));
    return 0;
  }

  if (args[0] === "set-engine") {
    if (args.length !== 3 && args.length !== 4) {
      throw new CliUsageError(
        "usage: ak-role config set-engine <seat> <name> [model]",
      );
    }
    const seat = args[1]!;
    const name = args[2]!;
    const engineModel = args[3];
    requireCallableSeat(seat, "engine", "set-engine");
    requireLegalEngineName(name);
    if (engineModel !== undefined) requireLegalEngineModel(engineModel);
    let config = await loadAndValidateConfig(home, packageRoot);
    try {
      config = setPersistentSeatEngine(config, seat, name, engineModel);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config, home));
    return 0;
  }

  if (args[0] === "unset-engine") {
    if (args.length !== 2) {
      throw new CliUsageError(
        "usage: ak-role config unset-engine <seat>",
      );
    }
    const seat = args[1]!;
    requireCallableSeat(seat, "engine", "unset-engine");
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
    io.stdout(renderConfig(config, home));
    return 0;
  }

  if (args[0] === "set-engine-model") {
    if (args.length !== 3) {
      throw new CliUsageError(
        "usage: ak-role config set-engine-model <seat> <model>",
      );
    }
    const seat = args[1]!;
    const model = args[2]!;
    requireCallableSeat(seat, "engine", "set-engine-model");
    requireLegalEngineModel(model);
    let config = await loadAndValidateConfig(home, packageRoot);
    try {
      config = setPersistentSeatEngineModel(config, seat, model);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config, home));
    return 0;
  }

  if (args[0] === "unset-engine-model") {
    if (args.length !== 2) {
      throw new CliUsageError(
        "usage: ak-role config unset-engine-model <seat>",
      );
    }
    const seat = args[1]!;
    requireCallableSeat(seat, "engine", "unset-engine-model");
    let config = await loadAndValidateConfig(home, packageRoot);
    try {
      config = setPersistentSeatEngineModel(config, seat, undefined);
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    await savePublicCliConfig(config, home);
    io.stdout(renderConfig(config, home));
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
    io.stdout(renderConfig(config, home));
    return 0;
  }

  throw new CliUsageError(`unknown config subcommand: ${args[0]}`);
}

/**
 * #855: process-cancel handlers only for commands that run a role turn
 * (callable roles / resume / new). analyst/roles/config/help keep Node's
 * default SIGINT/SIGTERM termination — installing handlers would swallow Ctrl+C.
 */
export function commandNeedsProcessCancel(argv: readonly string[]): boolean {
  // Decision-time parse must not escape the CLI usage boundary. Malformed
  // global flags throw CliUsageError here; return false and let runAkRole
  // present the same structured usage reject (exit 2). Handlers are moot
  // when parse fails — install-or-not has no subsequent effect.
  let parsed: ParsedGlobal;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    if (error instanceof CliUsageError) return false;
    throw error;
  }
  if (parsed.help || parsed.command === undefined || parsed.command === "help") {
    return false;
  }
  if (parsed.command === "resume" || parsed.command === "new") return true;
  return isPublicCallableRole(parsed.command);
}

export async function runAkRole(
  argv: readonly string[],
  env: CliEnv,
): Promise<CliResult> {
  const io = env.io ?? defaultIo();

  try {
    // Select the installed package identity once, before any role-owned Skill,
    // runtime entry, activation argv, or invocation provenance is derived.
    env = {
      ...env,
      packageRoot: await realpath(env.packageRoot),
      principalAuthority: env.principalAuthority ?? piDurablePrincipalAuthority,
    };
    let parsed = parseArgv(argv);
    // Host/engine axes: callable roles + resume + new (#617 DK-3; #724 new shares seat axes).
    // Support commands (roles/config/…) still refuse both flags.
    const acceptsSeatAxes =
      parsed.command !== undefined &&
      (isPublicCallableRole(parsed.command) ||
        parsed.command === "resume" ||
        parsed.command === "new");
    if (
      parsed.host !== undefined &&
      !parsed.help &&
      parsed.command !== undefined &&
      parsed.command !== "help" &&
      !acceptsSeatAxes
    ) {
      throw new CliUsageError(`host axis is role commands only; refused command ${parsed.command}`);
    }
    if (parsed.engine !== undefined) {
      requireLegalEngineName(parsed.engine);
      if (
        !parsed.help &&
        parsed.command !== undefined &&
        parsed.command !== "help" &&
        !acceptsSeatAxes
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
      // Home-free path: never touch passwd/user profile for help/bare/--help.
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

    // Profile home only after home-free paths return. Failures keep real identity
    // and settle through the outer catch — no $HOME fallback (#604).
    const home = resolveHome(env);

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

    // #724 explicit fresh summons: `ak-role new <role> …` — same role argv, always mint.
    // Rewrites onto the role command with freshSummons; auto-resume and resume stay intact.
    if (parsed.command === "new") {
      const role = parsed.args[0];
      if (role === undefined) {
        throw new CliUsageError("usage: ak-role new <role> …");
      }
      if (!isPublicCallableRole(role)) {
        throw new CliUsageError(`usage: ak-role new <role> …; unknown role: ${role}`);
      }
      parsed = {
        ...parsed,
        command: role,
        args: parsed.args.slice(1),
      };
      env = { ...env, freshSummons: true };
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
      // Missing durable role keeps the judge seat table. The resume entry
      // itself is one function; it reads the stored run.
      const seatRole = resumeRole ?? "judge";
      const seat = resolveEffectiveSeat(
        config,
        seatRole,
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicInstructionSeatResume(
        resumeRequest,
        createRoleEnvironment(env, {
          role: seatRole,
          home,
          agentDir,
          cwd,
          credentials,
          seat,
          config,
        }),
        io,
      );
      let current = result;
      while (
        current.exitCode === 0 && current.admitted?.correlationId !== undefined
        && current.terminal?.roleOutcome.kind === "accepted"
        && !latestPayloadEscalated(current.terminal.roleOutcome)
      ) {
        const parentRunId = current.admitted.correlationId;
        const parentRole = await peekRoleRunRole(home, parentRunId);
        if (parentRole === undefined) break;
        const parentSeat = resolveEffectiveSeat(config, parentRole, credentials, invocationFromParsed(parsed));
        const parentEnv = createRoleEnvironment(env, {
          role: parentRole, home, agentDir, cwd, credentials, seat: parentSeat, config,
        });
        current = await continueParentAfterChild(parentRunId, current.admitted, parentEnv, io);
      }
      return cliResultFromRoleRun(current);
    }

    if (
      parsed.command !== undefined &&
      isPublicCliSupportCommand(parsed.command)
    ) {
      throw new CliUsageError(`unhandled support command: ${parsed.command}`);
    }

    // Public LLM role commands share one spine: registry parser → one runner.
    if (parsed.command !== undefined && isPublicCallableRole(parsed.command)) {
      const role = parsed.command;
      return await dispatchPublicRoleCommand(
        env, home, io, parsed, role,
        (args) => PUBLIC_ROLE_ARGV[role].parse(args) as PublicSeatParse,
        (args, roleEnv, once) => runPublicInstructionSeat(args, roleEnv, io, role, once),
      );
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
    if (error instanceof HostSelectionError) {
      io.stderr(formatCliDiagnostic(formatHostSelectionFailure(error.failure)));
      return { exitCode: 1, hostFailure: error.failure };
    }
    if (error instanceof CliUsageError) {
      // Non-judge structural paths share the same rejection presenter as Judge.
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    // Unrecognized outer failure: retain actual name/message identity (no wash).
    // #676 B: cause (HTTP body/headers, git stderr, nested Error) must reach the
    // caller via the same formatErrorCauseDetail face as structural rejection.
    if (error instanceof Error) {
      let label =
        error.name !== "" && error.name !== "Error"
          ? `${error.name}: ${error.message}`
          : error.message;
      if (error.cause !== undefined) {
        const detail = formatErrorCauseDetail(error.cause);
        if (detail.trim().length > 0) {
          label = `${label || error.name || "exception"}; cause: ${detail}`;
        }
      }
      io.stderr(formatCliDiagnostic(label || error.name || "exception"));
      return { exitCode: 1 };
    }
    io.stderr(formatCliDiagnostic(String(error)));
    return { exitCode: 1 };
  }
}
