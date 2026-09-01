import type { DurablePrincipalAuthority } from "../host-contracts.ts";
import { piDurablePrincipalAuthority } from "../pi/durable-principal.ts";
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
  setPersistentSeatHost,
  validatePublicCliConfigAxes,
  type CredentialProviders,
  type EffectiveSeat,
  type InvocationModelOverride,
  type PublicCliConfig,
} from "./config.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { CliIo } from "./cli-io.ts";
import type { RoleTurnHost } from "../host-contracts.ts";
import { loadProductionGrokHostFactory } from "./load-production-grok-host.ts";
import {
  createPiRoleTurnHost,
  appendPiSessionCustomEntry,
} from "../pi/role-turn-host.ts";
import {
  observeLaunchedRolePackageIdentity,
  parseAnalystArgv,
  parseCoderArgv,
  parseCollectorArgv,
  parseCountersignArgv,
  parseGleanerLeftArgv,
  parseDoctorArgv,
  parseFixerArgv,
  parseJudgeArgv,
  parseMergerArgv,
  parseNotaryArgv,
  parseReviewerArgv,
  recordLaunchedPiIdentity,
  recordLaunchedRolePackageIdentity,
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
import { runPublicCountersign } from "./countersign-run.ts";
import { runPublicGleanerLeft } from "./gleaner-left-run.ts";
import { ONE_SHOT_ROLES } from "../packaged-role-registry.ts";
import { runPublicDoctor } from "./doctor-run.ts";
import { runPublicFixer, runPublicFixerResume } from "./fixer-run.ts";
import { runPublicNotary } from "./notary-run.ts";
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
} from "../pi/role-turn-host.ts";
export { CliUsageError } from "./cli-errors.ts";
export type { CliIo } from "./cli-io.ts";

/**
 * Sole production map: public role command → argv parser + option definitions.
 * cli handlers and help consume this table; no parallel spelling set (#342).
 */
export const PUBLIC_ROLE_ARGV = {
  judge: { parse: parseJudgeArgv, options: optionsForOwner("judge") },
  countersign: { parse: parseCountersignArgv, options: optionsForOwner("countersign") },
  "gleaner-left": { parse: parseGleanerLeftArgv, options: optionsForOwner("gleaner-left") },
  coder: { parse: parseCoderArgv, options: optionsForOwner("coder") },
  fixer: { parse: parseFixerArgv, options: optionsForOwner("fixer") },
  collector: { parse: parseCollectorArgv, options: optionsForOwner("collector") },
  doctor: { parse: parseDoctorArgv, options: optionsForOwner("doctor") },
  merger: { parse: parseMergerArgv, options: optionsForOwner("merger") },
  notary: { parse: parseNotaryArgv, options: optionsForOwner("notary") },
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

export type HostSelectionFailure = {
  readonly kind: "host-unregistered" | "host-model-mismatch";
  readonly host: string;
  readonly seat: PublicCallableRole;
  readonly model: string;
  readonly registeredHosts: readonly string[];
};

export type NamedRoleTurnHostAdapter = {
  readonly name: string;
  readonly create: (input: { role: PublicCallableRole; model: EffectiveSeat["selection"] }) =>
    | { readonly ok: true; readonly host: RoleTurnHost }
    | { readonly ok: false };
};

class HostSelectionError extends Error {
  constructor(readonly failure: HostSelectionFailure) { super(failure.kind); }
}

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
   * adapter once per dispatch from packageRoot + seat extraPiArgs/timeout.
   */
  roleTurnHost?: RoleTurnHost;
  /** Composition-root-owned unique named adapter table. */
  hostAdapters?: readonly NamedRoleTurnHostAdapter[];
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

/** Compose the Pi turn host for one role dispatch (sole public-cli → pi contact). */
function resolveRoleTurnHost(
  env: CliEnv,
  options: {
    role: PublicCallableRole;
    seat: EffectiveSeat;
    principalAuthority: DurablePrincipalAuthority;
    extraPiArgs?: readonly string[];
    timeoutMs?: number;
  },
): RoleTurnHost {
  const piHost = env.roleTurnHost ?? createPiRoleTurnHost({
    packageRoot: env.packageRoot,
    principalAuthority: options.principalAuthority,
    ...(options.extraPiArgs === undefined ? {} : { extraPiArgs: options.extraPiArgs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    recordLaunchedPiIdentity,
    recordLaunchedRolePackageIdentity,
    observeLaunchedRolePackageIdentity,
  });
  // Composition-root unique adapter table (#522 / #580): pi + S6 grok-build true adapter.
  const adapters = env.hostAdapters ?? [
    { name: "pi", create: () => ({ ok: true as const, host: piHost }) },
    {
      name: "grok-build",
      create: () => {
        // Factory loads outside the public bin static graph (ADR 0052 peer-free discovery).
        let hostPromise: Promise<RoleTurnHost> | undefined;
        return {
          ok: true as const,
          host: {
            executeTurn: async (request) => {
              hostPromise ??= loadProductionGrokHostFactory(env.packageRoot).then((create) =>
                create({
                  packageRoot: env.packageRoot,
                  principalAuthority: options.principalAuthority,
                }),
              );
              return (await hostPromise).executeTurn(request);
            },
          },
        };
      },
    },
  ];
  const hostName = options.seat.host;
  const adapter = adapters.find((candidate) => candidate.name === hostName);
  const model = options.seat.selection === undefined ? "unconfigured" : `${options.seat.selection.provider}/${options.seat.selection.model}`;
  const registeredHosts = adapters.map(({ name }) => name);
  if (adapter === undefined) {
    throw new HostSelectionError(
      { kind: "host-unregistered", host: hostName, seat: options.role, model, registeredHosts },
    );
  }
  const selected = adapter.create({ role: options.role, model: options.seat.selection });
  if (!selected.ok) {
    throw new HostSelectionError(
      { kind: "host-model-mismatch", host: hostName, seat: options.role, model, registeredHosts },
    );
  }
  return selected.host;
}

type RoleEnvironmentOptions = {
  role: PublicCallableRole;
  home: string;
  agentDir: string;
  cwd: string;
  credentials?: CredentialProviders;
  seat: EffectiveSeat;
  config?: PublicCliConfig;
  /**
   * Resume must not inject seat startup/persistent defaults as env.model — those
   * would mask admitted.model restoration (standards-2 second facet). Only an
   * explicit invocation --model (source === "invocation") is forwarded.
   */
  resume?: boolean;
};

function createRoleEnvironment(
  env: CliEnv,
  options: RoleEnvironmentOptions,
) {
  const role = options.role;
  const extraPiArgs =
    role === "coder"
      ? env.coderExtraPiArgs
      : role === "fixer"
        ? env.fixerExtraPiArgs
        : role === "reviewer"
          ? env.reviewerExtraPiArgs
          : role === "merger"
            ? env.mergerExtraPiArgs
            : role === "judge"
              ? env.judgeExtraPiArgs
              : role === "collector"
                ? env.collectorExtraPiArgs
                : role === "doctor"
                  ? env.doctorExtraPiArgs
                  : role === "notary"
                    ? env.notaryExtraPiArgs
                    : undefined;
  const timeoutMs =
    role === "coder"
      ? env.coderTimeoutMs
      : role === "fixer"
        ? env.fixerTimeoutMs
        : role === "reviewer"
          ? env.reviewerTimeoutMs
          : role === "merger"
            ? env.mergerTimeoutMs
            : role === "judge"
              ? env.judgeTimeoutMs
              : role === "collector"
                ? env.collectorTimeoutMs
                : role === "doctor"
                  ? env.doctorTimeoutMs
                  : role === "notary"
                    ? env.notaryTimeoutMs
                    : undefined;

  // Initial runs take seat.selection from any source (invocation/persistent/startup).
  // Resume only forwards an explicit CLI --model; otherwise env.model stays unset so
  // resolveResumeModel can restore admitted.model (incl. thinking).
  const injectModel =
    options.seat.selection !== undefined &&
    (options.resume !== true || options.seat.source === "invocation");

  return {
    home: options.home,
    principalAuthority: env.principalAuthority!,
    agentDir: options.agentDir,
    sessionAppender: appendPiSessionCustomEntry,
    packageRoot: env.packageRoot,
    roleTurnHost: resolveRoleTurnHost(env, {
      role,
      seat: options.seat,
      principalAuthority: env.principalAuthority!,
      ...(extraPiArgs === undefined ? {} : { extraPiArgs }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    cwd: options.cwd,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(env.correlationId === undefined ? {} : { correlationId: env.correlationId }),
    ...(injectModel ? { model: options.seat.selection } : {}),
    ...projectSeatEngine(options.seat),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(env.createRunId === undefined ? {} : { createRunId: env.createRunId }),
    ...(options.config?.autoResumeLimit === undefined
      ? {}
      : { autoResumeLimit: options.config.autoResumeLimit }),
  };
}

export type CliResult = {
  exitCode: number;
  /** Settled Terminal when an admitted Role run produced one (programmatic/tests). */
  terminal?: TerminalResult;
  hostFailure?: HostSelectionFailure;
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
  host?: string;
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

/** Callable seats own persistent call axes; automatic seats have no call path. */
function requireCallableSeat(
  seat: string,
  axis: "engine" | "host",
  verb: "set-engine" | "unset-engine" | "set-host" | "unset-host",
): asserts seat is PublicCallableRole {
  if (isAutomaticConfigurableSeat(seat)) {
    throw new CliUsageError(
      `config ${verb} refuses ${seat}: no independent activation path; storing would be silently ineffective`,
    );
  }
  if (!isPublicCallableRole(seat)) {
    throw new CliUsageError(`unknown ${axis}-axis seat: ${seat}`);
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
    "Persistent engine (callable roles): ak-role config set-engine <seat> <name> | unset-engine <seat>",
    "Persistent host (callable roles): ak-role config set-host <seat> <name> | unset-host <seat>",
    "Host resolution: --host → persistent seat host → pi; after set-host the role command face is unchanged",
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
  const lines: string[] = ["seat\tmodel\tengine\thost"];
  const keys = Object.keys(config.seats) as (keyof typeof config.seats)[];
  if (keys.length === 0) {
    lines.push("(empty)");
  } else {
    for (const seat of keys.sort()) {
      const selection = config.seats[seat];
      if (selection === undefined) continue;
      const engine = selection.engine === undefined ? "-" : selection.engine;
      const host = selection.host === undefined ? "-" : selection.host;
      lines.push(`${seat}\t${renderPersistentSeatModel(selection)}\t${engine}\t${host}`);
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
        const engine = selection.engine === undefined ? "-" : selection.engine;
        const host = selection.host === undefined ? "-" : selection.host;
        io.stdout(`${args[1]}\t${renderPersistentSeatModel(selection)}\t${engine}\t${host}\n`);
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
    requireCallableSeat(seat, "engine", "set-engine");
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
    env = {
      ...env,
      packageRoot: await realpath(env.packageRoot),
      principalAuthority: env.principalAuthority ?? piDurablePrincipalAuthority,
    };
    const parsed = parseArgv(argv);
    // Invocation --engine rejects at the call-request seam (not role submission).
    // #356 / #378 / #391: engine axis is every callable role (not resume / support).
    if (parsed.host !== undefined && parsed.command === "resume") {
      throw new CliUsageError("resume cannot change host");
    }
    if (
      parsed.host !== undefined &&
      !parsed.help &&
      parsed.command !== undefined &&
      parsed.command !== "help" &&
      !isPublicCallableRole(parsed.command)
    ) {
      throw new CliUsageError(`host axis is role commands only; refused command ${parsed.command}`);
    }
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
      // One-shot seats refuse resume — single typed owner, not a per-role chain.
      if (resumeRole !== undefined && ONE_SHOT_ROLES.includes(resumeRole)) {
        throw new CliUsageError(
          `${resumeRole} role runs are one-shot and cannot be resumed`,
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
          createRoleEnvironment(env, {
            role: "coder",
            home,
            agentDir,
            cwd,
            credentials,
            seat,
            config,
            resume: true,
          }),
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
          createRoleEnvironment(env, {
            role: "fixer",
            home,
            agentDir,
            cwd,
            credentials,
            seat,
            config,
            resume: true,
          }),
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
          createRoleEnvironment(env, {
            role: "reviewer",
            home,
            agentDir,
            cwd,
            credentials,
            seat,
            config,
            resume: true,
          }),
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
          createRoleEnvironment(env, {
            role: "merger",
            home,
            agentDir,
            cwd,
            credentials,
            seat,
            config,
            resume: true,
          }),
          io,
        );
        return {
          exitCode: result.exitCode,
          ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
        };
      }
      const result = await runPublicResume(
        resumeRequest,
        createRoleEnvironment(env, {
          role: "judge",
          home,
          agentDir,
          cwd,
          credentials,
          seat,
          config,
          resume: true,
        }),
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
        createRoleEnvironment(env, { role: "judge", home, agentDir, cwd, credentials, seat, config }),
        io,
        PUBLIC_ROLE_ARGV.judge.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Countersign ticket-court run path (#572 / ADR 0074) — one-shot.
    if (parsed.command === "countersign") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadAndValidateConfig(home, env.packageRoot);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "countersign",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicCountersign(
        parsed.args,
        createRoleEnvironment(env, { role: "countersign", home, agentDir, cwd, credentials, seat, config }),
        io,
        PUBLIC_ROLE_ARGV.countersign.parse,
      );
      return {
        exitCode: result.exitCode,
        ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
      };
    }

    // Gleaner-Left pre-merge memorial run path (#502 / ADR 0067) — one-shot.
    if (parsed.command === "gleaner-left") {
      const agentDir = resolveAgentDir(env, home);
      const cwd = env.cwd ?? process.cwd();
      const config = await loadAndValidateConfig(home, env.packageRoot);
      const credentials =
        env.credentials ?? (await loadCredentialProviders(agentDir));
      const seat = resolveEffectiveSeat(
        config,
        "gleaner-left",
        credentials,
        invocationFromParsed(parsed),
      );
      const result = await runPublicGleanerLeft(
        parsed.args,
        createRoleEnvironment(env, { role: "gleaner-left", home, agentDir, cwd, credentials, seat, config }),
        io,
        PUBLIC_ROLE_ARGV["gleaner-left"].parse,
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
        createRoleEnvironment(env, { role: "coder", home, agentDir, cwd, credentials, seat, config }),
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
        createRoleEnvironment(env, { role: "fixer", home, agentDir, cwd, credentials, seat, config }),
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
        createRoleEnvironment(env, { role: "collector", home, agentDir, cwd, credentials, seat, config }),
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
        createRoleEnvironment(env, { role: "reviewer", home, agentDir, cwd, credentials, seat, config }),
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
        createRoleEnvironment(env, { role: "doctor", home, agentDir, cwd, credentials, seat, config }),
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
        createRoleEnvironment(env, { role: "notary", home, agentDir, cwd, credentials, seat, config }),
        io,
        PUBLIC_ROLE_ARGV.notary.parse,
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
        createRoleEnvironment(env, { role: "merger", home, agentDir, cwd, credentials, seat, config }),
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
    if (error instanceof HostSelectionError) {
      const registered = error.failure.registeredHosts.join(", ");
      io.stderr(formatCliDiagnostic(`${error.failure.kind}: ${error.failure.host}; registered: ${registered}`));
      return { exitCode: 1, hostFailure: error.failure };
    }
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
