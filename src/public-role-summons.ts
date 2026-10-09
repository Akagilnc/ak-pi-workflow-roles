/**
 * Role-inside-role summons via the single public activation path (#675).
 * Gate / compliance / evidence callers invoke the same post-admission face a
 * human uses; no second institutional session open, no model-only seat page.
 *
 * Lazy-loads every local value dependency. Pi loads extensions through jiti
 * (CJS transform, moduleCache:false); a static import graph that re-enters this
 * module via settlement → compliance leaves binding slots undefined
 * (`reading 'dirname'`, `reading 'tryHomeFromAkRolesPath'`). Dynamic import
 * starts after the caller module has finished init, so those slots stay intact.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CliIo } from "./public-cli/cli-io.ts";
import type { CredentialProviders, EffectiveSeat } from "./public-cli/config.ts";
import type { PublicCallableRole } from "./public-cli/registry.ts";
import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnModelConfig,
} from "./host-contracts.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";
import type { HostSelectionFailure, NamedRoleTurnHostAdapter } from "./public-cli/role-turn-host-resolution.ts";

import { isRecord, errorText } from "./unknown-value.ts";
import { serializeThrownValue } from "./serialize-thrown-value.ts";

/** Env published by the parent activation so nested summons never re-derive root. */
export const AK_ROLE_PACKAGE_ROOT_ENV = "AK_ROLE_PACKAGE_ROOT" as const;

export type PublicSummonRole =
  | "inspector"
  | "notary"
  | "auditor"
  | "navigator"
  | "gatekeeper"
  | "judge"
  | "doctor"
  | "diarist"
  | "countersign"
  | "reviewer";

export type PublicSummonRequest = {
  readonly role: PublicSummonRole;
  /** Argv after the role token (same shape as `ak-role <role> …`). */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Package home; derived from source run when omitted. */
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: CliIo;
  readonly credentials?: CredentialProviders;
  /** Parent turn's effective seat axes for same-seat child legs. */
  readonly model?: RoleTurnModelConfig;
  readonly host?: string;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly agentDir?: string;
  /** Parent durable-principal authority; defaults to the Pi adapter. */
  readonly principalAuthority?: DurablePrincipalAuthority;
  /** Parent role-run timeout projected onto the child turn request. */
  readonly timeoutMs?: number;
  /**
   * Optional Pi argv forwarded to the role-turn host (same face as public CLI
   * seat extraPiArgs). Callers pass explicitly — no process.env test protocol.
   */
  readonly extraPiArgs?: readonly string[];
  /**
   * Parent cancellation. A nested summon is an in-process await over a child
   * activation; without this the child keeps running (and spending) after the
   * parent tool call is cancelled (#675).
   */
  readonly signal?: AbortSignal;
  /**
   * #753 plain-language re-ask when the prior officer reply was not three-state.
   * Nested gate officers (notary + inspector) — rides same-ticket resume
   * summons.instruction. Never folded into argv / parent-run lookup keys.
   */
  readonly reviewReask?: string;
  /**
   * #879 same-parent (and first-mint) gate summons: verbatim parent-submission body.
   * Rides summons.instruction / first-mint prompt when reviewReask is absent.
   * Never folded into argv / parent-run lookup keys (binding pointer stays pure).
   */
  readonly gateReviewInstruction?: string;
  /**
   * Pi-adapter inject (tests). Used only as the `pi` row when composing the
   * adapter table — never as an override of the child seat's selected host.
   */
  readonly roleTurnHost?: RoleTurnHost;
  /**
   * Composition-root adapter table (tests / parent CLI env). Child seat selects
   * from this table. Production leaves unset and composes the default table.
   */
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  /** Offline test inject for deterministic run ids (same face as public CLI). */
  readonly createRunId?: () => string;
  /** Typed ticket number handoff for diarist child run (#840). Bind only — not a resume key (#987). */
  readonly boundTicketNumber?: number;
  /**
   * Gate / officer same-parent resume key (#747 / #987). Countersign gate re-ask
   * looks up prior 给事中 by this parent run directory, never by ticket number.
   */
  readonly parentRunPath?: string;
  /** Caller correlation id for nested leg ledger (ADR 0010 / #924). */
  readonly correlationId?: string;
  /**
   * Resume an existing instruction-seat run via public CLI resume (host-native
   * session continuity). Used by navigator attendance so prior advice stays on
   * the host session — not a package-built advice ledger.
   */
  readonly resumeRunId?: string;
  readonly resumeRunDirectory?: string;
  /**
   * Nested court station child (default true): omit Navigator auto-attendance
   * and use station-child resume. Ordinary public-equivalent legs (dual-lens
   * Reviewer axes) pass false so behavior matches a top-level single-axis call
   * (#946 / ADR 0082).
   */
  readonly stationChild?: boolean;
  /**
   * #1160 attendance auto byStatus prepare. Nested navigator only — never set
   * on direct `ak-role navigator` (keeps free-form prose exit).
   */
  readonly navigatorByStatusPrepare?: boolean;
};

const execFileAsync = promisify(execFile);

export type PublicSummonResult = {
  readonly exitCode: number;
  readonly terminal?: TerminalResult;
  /** Independent officer/role run directory (正本). Parent does not book a copy (#1195). */
  readonly runDirectory?: string;
  /** Offline diagnostics from nested CLI (structural rejection text). */
  readonly stderr?: string;
  /** Admitted role invocation from nested run. */
  readonly admitted?: import("./public-cli/invocation.ts").AdmittedRoleInvocation;
};

function createCapturingIo(): { io: CliIo; stderrText(): string } {
  const chunks: string[] = [];
  return {
    io: {
      stdout() {},
      stderr(text: string) {
        chunks.push(text);
      },
    },
    stderrText: () => chunks.join(""),
  };
}

/** Path parent without depending on a jiti-bound `path.dirname` closure. */
function parentDir(path: string): string {
  const end = path.endsWith("/") || path.endsWith("\\") ? path.slice(0, -1) : path;
  const idx = Math.max(end.lastIndexOf("/"), end.lastIndexOf("\\"));
  if (idx <= 0) return end;
  return end.slice(0, idx);
}

function walkPackageRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "souls"))) {
      return dir;
    }
    const parent = parentDir(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve install package root for nested public summons.
 * Prefer explicit / env coordinates; never require import.meta under jiti.
 */
export function resolveSummonsPackageRoot(explicit?: string): string {
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return explicit;
  }
  const fromEnv = process.env[AK_ROLE_PACKAGE_ROOT_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv;
  }
  const fromCwd = walkPackageRoot(process.cwd());
  if (fromCwd !== undefined) return fromCwd;
  try {
    const metaUrl = import.meta.url;
    if (typeof metaUrl === "string" && metaUrl.startsWith("file:")) {
      const filePath = decodeURIComponent(metaUrl.slice("file://".length));
      const fromMeta = walkPackageRoot(parentDir(filePath));
      if (fromMeta !== undefined) return fromMeta;
    }
  } catch {
    // import.meta unavailable — fall through.
  }
  throw new Error(
    "public role summons cannot resolve package root (pass packageRoot or set AK_ROLE_PACKAGE_ROOT)",
  );
}

async function resolveSummonHome(options: PublicSummonRequest): Promise<string> {
  if (options.home !== undefined && options.home.trim() !== "") {
    return options.home;
  }
  const { tryHomeFromAkRolesPath, packageMachineHome } = await import(
    "./activation-ledger-topology.ts"
  );
  const fromCwd = tryHomeFromAkRolesPath(options.cwd);
  if (fromCwd !== undefined && fromCwd.length > 0) return fromCwd;
  return packageMachineHome();
}

function hostSelectionFailureFromUnknown(error: unknown): HostSelectionFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ((error as { name?: unknown }).name !== "HostSelectionError") return undefined;
  const failure = (error as { failure?: HostSelectionFailure }).failure;
  return failure;
}

type SummonEnvOk = {
  readonly home: string;
  readonly principalAuthority: DurablePrincipalAuthority;
  readonly agentDir: string;
  readonly sessionAppender: typeof import("./pi/role-turn-host.ts").appendPiSessionCustomEntry;
  readonly packageRoot: string;
  readonly roleTurnHost: RoleTurnHost;
  readonly cwd: string;
  readonly credentials: CredentialProviders;
  readonly model?: import("./host-contracts.ts").HostInstitutionalModelSelection;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly host?: string;
  readonly timeoutMs?: number;
};

/** #178: missing model is ok:false (typed fact), not a thrown message. */
type SummonEnvBuild =
  | { readonly ok: true; readonly env: SummonEnvOk }
  | { readonly ok: false; readonly missingModelMessage: string };

async function createSummonEnv(
  options: {
    readonly role: PublicCallableRole;
    readonly home: string;
    readonly agentDir: string;
    readonly cwd: string;
    readonly packageRoot: string;
    readonly credentials: CredentialProviders;
    readonly seat: EffectiveSeat;
    readonly extraPiArgs?: readonly string[];
    readonly roleTurnHost?: RoleTurnHost;
    readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
    readonly principalAuthority?: DurablePrincipalAuthority;
    readonly timeoutMs?: number;
    /** Parent env model already host-facing — never project a second time. */
    readonly hostFacingModel?: RoleTurnModelConfig;
  },
  /** #178: after host selection, before missing-model — structural argv parse once. */
  afterHost?: () => void,
): Promise<SummonEnvBuild> {
  const [
    { piDurablePrincipalAuthority },
    { appendPiSessionCustomEntry },
    { openRoleSeatRuntime },
    { missingResolvedSeatModelMessage },
  ] = await Promise.all([
    import("./pi/durable-principal.ts"),
    import("./pi/role-turn-host.ts"),
    import("./public-cli/role-seat-runtime.ts"),
    import("./public-cli/config.ts"),
  ]);
  const principalAuthority = options.principalAuthority ?? piDurablePrincipalAuthority;
  const opened = openRoleSeatRuntime({
    resolution: {
      packageRoot: options.packageRoot,
      ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
      ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
      ...(options.extraPiArgs === undefined || options.extraPiArgs.length === 0
        ? {}
        : { extraPiArgs: options.extraPiArgs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    principalAuthority,
    role: options.role,
    seat: options.seat,
    home: options.home,
    ...(afterHost === undefined ? {} : { afterHost }),
    ...(options.hostFacingModel === undefined ? {} : { hostFacingModel: options.hostFacingModel }),
  });
  if (!opened.ok) {
    return {
      ok: false,
      missingModelMessage: missingResolvedSeatModelMessage(options.role),
    };
  }
  return {
    ok: true,
    env: {
      home: options.home,
      principalAuthority,
      agentDir: options.agentDir,
      sessionAppender: appendPiSessionCustomEntry,
      packageRoot: options.packageRoot,
      roleTurnHost: opened.roleTurnHost,
      cwd: options.cwd,
      credentials: options.credentials,
      ...(opened.model === undefined ? {} : { model: opened.model }),
      ...(opened.engine === undefined ? {} : { engine: opened.engine }),
      ...(opened.engineModel === undefined ? {} : { engineModel: opened.engineModel }),
      host: opened.host,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  };
}

/**
 * Summon one public callable role through the same runners the CLI uses
 * (ADR 0052 / #675). Seat axes come from the live table.
 */
export async function summonPublicRole(
  options: PublicSummonRequest,
): Promise<PublicSummonResult> {
  const packageRoot = resolveSummonsPackageRoot(options.packageRoot);
  const home = await resolveSummonHome(options);
  const {
    loadCredentialProviders,
    loadPublicCliConfig,
    resolveEffectiveSeat,
    resolvePublicAgentDir,
    validatePublicCliConfigAxes,
  } = await import("./public-cli/config.ts");
  const agentDir = resolvePublicAgentDir(options.agentDir, home);
  const credentials =
    options.credentials ?? (await loadCredentialProviders(agentDir));
  const config = await loadPublicCliConfig(home);
  validatePublicCliConfigAxes(config, packageRoot);
  // Nested summons: officer seat only (flag>seat>default pi). #178 order below.
  const resolvedSeat = resolveEffectiveSeat(config, options.role, credentials);
  const inheritedSelection = options.model === undefined
    ? undefined
    : {
        provider: options.model.provider,
        model: options.model.model,
        ...(options.model.thinking === undefined
          ? {}
          : { thinking: options.model.thinking as import("./public-cli/registry.ts").PublicThinkingLevel }),
      };
  const seat: EffectiveSeat = {
    ...resolvedSeat,
    ...(inheritedSelection === undefined
      ? {}
      : { selection: inheritedSelection, source: "invocation" as const }),
    ...(options.host === undefined
      ? {}
      : { host: options.host, hostSource: "invocation" as const }),
    ...(options.engine === undefined
      ? {}
      : { engine: options.engine, engineSource: "invocation" as const }),
    ...(options.engineModel === undefined ? {} : { engineModel: options.engineModel }),
  };
  const captured = options.io === undefined ? createCapturingIo() : undefined;
  const io = options.io ?? captured!.io;

  const summonEnvInput = {
    role: options.role,
    home,
    agentDir,
    cwd: options.cwd,
    packageRoot,
    credentials,
    seat,
    ...(options.extraPiArgs === undefined ? {} : { extraPiArgs: options.extraPiArgs }),
    ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
    ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
    ...(options.principalAuthority === undefined
      ? {}
      : { principalAuthority: options.principalAuthority }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    // Parent model is already host-facing; child must not project again.
    ...(options.model === undefined ? {} : { hostFacingModel: options.model }),
  } as const;

  type Prepared =
    | { readonly ok: true; readonly env: Record<string, unknown> }
    | { readonly ok: false; readonly exitCode: number; readonly stderr?: string };

  async function prepareSummonEnv(afterHost: () => void): Promise<Prepared> {
    try {
      const built = await createSummonEnv(summonEnvInput, afterHost);
      if (!built.ok) {
        return { ok: false, exitCode: 1, stderr: built.missingModelMessage };
      }
      return {
        ok: true,
        env: {
          ...built.env,
          // Nested court stations keep station-child semantics; dual-lens
          // ordinary Reviewer axes opt out (#946 / ADR 0082).
          ...(options.stationChild === false ? {} : { stationChild: true }),
          ...(options.navigatorByStatusPrepare === true
            ? { navigatorByStatusPrepare: true as const }
            : {}),
          // Forward composition-root adapters so nested stations (e.g.
          // secretariat → diarist) select the same faux/production table (#924).
          ...(options.hostAdapters === undefined
            ? {}
            : { hostAdapters: options.hostAdapters }),
          ...(config.autoResumeLimit === undefined
            ? {}
            : { autoResumeLimit: config.autoResumeLimit }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.reviewReask === undefined ? {} : { reviewReask: options.reviewReask }),
          ...(options.gateReviewInstruction === undefined
            ? {}
            : { gateReviewInstruction: options.gateReviewInstruction }),
          ...(options.boundTicketNumber === undefined
            ? {}
            : { boundTicketNumber: options.boundTicketNumber }),
          ...(options.parentRunPath === undefined || options.parentRunPath.trim() === ""
            ? {}
            : { parentRunPath: options.parentRunPath }),
          ...(options.correlationId === undefined || options.correlationId.trim() === ""
            ? {}
            : { correlationId: options.correlationId }),
          ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
        },
      };
    } catch (error) {
      const failure = hostSelectionFailureFromUnknown(error);
      if (failure !== undefined) {
        const { formatHostSelectionFailure } = await import("./public-cli/role-turn-host-resolution.ts");
        return { ok: false, exitCode: 1, stderr: formatHostSelectionFailure(failure) };
      }
      const { CliUsageError } = await import("./public-cli/cli-errors.ts");
      if (error instanceof CliUsageError) {
        const { presentStructuralRejection } = await import("./public-cli/settlement.ts");
        presentStructuralRejection(error, io);
        return { ok: false, exitCode: 2 };
      }
      throw error;
    }
  }

  function projectPrepareFailure(prepared: Extract<Prepared, { ok: false }>): PublicSummonResult {
    const parts = [prepared.stderr, captured?.stderrText()].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    const stderr = parts.length === 0 ? undefined : parts.join("");
    return {
      exitCode: prepared.exitCode,
      ...(stderr === undefined ? {} : { stderr }),
    };
  }

  /** Host → argv once → missing-model → runner. */
  async function runPrepared<TParsed>(
    parse: (argv: readonly string[]) => TParsed,
    run: (
      env: Record<string, unknown>,
      parseOnce: () => TParsed,
    ) => Promise<{
      exitCode: number;
      terminal?: TerminalResult;
      admitted?: {
        readonly runDirectory?: string;
        readonly runId?: string;
        readonly role?: string;
      };
    }>,
  ) {
    let parsedArgv!: TParsed;
    const prepared = await prepareSummonEnv(() => {
      parsedArgv = parse(options.argv);
    });
    if (!prepared.ok) return { fail: projectPrepareFailure(prepared) as PublicSummonResult };
    return { ok: await run(prepared.env, () => parsedArgv) };
  }

  const [{ runPublicInstructionSeat, runPublicInstructionSeatResume }, { PUBLIC_ROLE_ARGV }] = await Promise.all([
    import("./public-cli/instruction-seat-run.ts"),
    import("./public-cli/cli.ts"),
  ]);
  const { packagedRoleMetadata } = await import("./packaged-role-registry.ts");
  const record = packagedRoleMetadata(options.role);
  const parse = ((args: readonly string[]) =>
    PUBLIC_ROLE_ARGV[options.role].parse(args)) as (args: readonly string[]) => import("./public-cli/invocation.ts").PublicSeatParse;
  const resumeRunId = record?.summonResume === true
    && typeof options.resumeRunId === "string"
    && options.resumeRunId.trim() !== ""
    ? options.resumeRunId.trim()
    : undefined;
  let result: {
    exitCode: number;
    terminal?: TerminalResult;
    admitted?: {
      readonly runDirectory?: string;
      readonly runId?: string;
      readonly role?: string;
    };
  };
  if (resumeRunId !== undefined) {
    const instruction = options.argv[0] ?? "";
    const stepped = await runPrepared(parse, (env) =>
      runPublicInstructionSeatResume(
        {
          runId: resumeRunId,
          ...(options.resumeRunDirectory === undefined ? {} : { runDirectory: options.resumeRunDirectory }),
          summons: {
            instruction,
            instructionEmpty: instruction.length === 0,
          },
        },
        env as never,
        io,
      ));
    if ("fail" in stepped) return stepped.fail;
    result = stepped.ok;
  } else {
    const stepped = await runPrepared(parse, (env, once) =>
      runPublicInstructionSeat(options.argv, env as never, io, options.role, once));
    if ("fail" in stepped) return stepped.fail;
    result = stepped.ok;
  }

  const stderr = captured?.stderrText();
  // Nested escalate may present a lower terminal; prefer that seat's admitted
  // runDirectory when already in hand — do not re-resolve bare runId across books (#1195).
  let runDirectory = result.admitted?.runDirectory;
  if (
    result.terminal !== undefined
    && result.terminal.roleOutcome.role !== options.role
    && typeof result.terminal.runId === "string"
    && result.admitted?.runId !== result.terminal.runId
  ) {
    // Compatibility surface with no admitted locator for that terminal.
    runDirectory = await (await import("./public-cli/run-lifecycle.ts")).findRunDirectoryById(
      home,
      result.terminal.runId,
    ) ?? runDirectory;
  }
  return {
    exitCode: result.exitCode,
    ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
    ...(result.admitted === undefined ? {} : { admitted: result.admitted as import("./public-cli/invocation.ts").AdmittedRoleInvocation }),
    ...(typeof runDirectory === "string" && runDirectory.trim() !== ""
      ? { runDirectory }
      : {}),
    ...(stderr === undefined || stderr === "" ? {} : { stderr }),
  };
}

/**
 * Inject `--lens` into a public Reviewer argv that has none. Keeps every other
 * token (including `--project` and `--`) exactly as the single-axis entry saw it.
 */
function withReviewerLens(
  argv: readonly string[],
  lens: "completeness" | "correctness",
): string[] {
  const separator = argv.indexOf("--");
  if (separator === -1) return [...argv, "--lens", lens];
  return [...argv.slice(0, separator), "--lens", lens, ...argv.slice(separator)];
}

/** Git toplevel for Reviewer pre-dispatch --base existence check (subdir-safe). */
async function resolveReviewerGitToplevel(projectRoot: string): Promise<string> {
  const callerProjectRoot = await realpath(projectRoot);
  return await realpath((await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: callerProjectRoot },
  )).stdout.trim());
}

/**
 * Default Reviewer call: two explicit single-axis public legs on the caller's
 * ticket worktree, started as one parallel batch (#997). Each leg reuses the
 * caller's public argv and only adds `--lens` (10a). No seat-specific ephemeral
 * copy — same shared tree as other seats. Lifecycle stays in this shared
 * summons seam, never in the role module (#946 / ADR 0018).
 *
 * Work-tree dirt and mid-batch HEAD drift are not package hard-stops (#1133):
 * each ordinary Reviewer leg judges and reports object state itself; this seam
 * records original child terminals as returned.
 */
export async function summonParallelReviewerLenses(options: {
  /** Public argv after the role token; must not already carry `--lens`. */
  readonly argv: readonly string[];
  /** Same cwd the single-axis public entry would receive for this call. */
  readonly cwd: string;
  readonly projectRoot: string;
  /** Typed --base from the public parse; used only for pre-dispatch fail-closed check. */
  readonly baseRevision: string;
  readonly home: string;
  readonly agentDir?: string;
  readonly credentials?: CredentialProviders;
  readonly model?: RoleTurnModelConfig;
  readonly host?: string;
  readonly engine?: string;
  readonly engineModel?: string;
  readonly packageRoot?: string;
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly roleTurnHost?: RoleTurnHost;
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  readonly principalAuthority?: DurablePrincipalAuthority;
  readonly timeoutMs?: number;
}): Promise<{
  readonly completeness: PublicSummonResult;
  readonly correctness: PublicSummonResult;
}> {
  const failedResult = (error: unknown): PublicSummonResult => ({
    exitCode: 1,
    stderr: serializeThrownValue(error),
  });
  const dualFailure = (error: unknown) => {
    const failure = failedResult(error);
    return { completeness: failure, correctness: failure } as const;
  };

  // Pre-dispatch: only verify typed --base resolves (subdir-safe). Missing base
  // keeps the dual-child batch surface. Status / HEAD are not package gates.
  try {
    const sourceProjectRoot = await resolveReviewerGitToplevel(options.projectRoot);
    // Typed base from the public parse — covers --base value and --base=value alike.
    // Child legs still carry the original argv token unchanged (10a).
    await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${options.baseRevision}^{commit}`],
      { cwd: sourceProjectRoot },
    );
  } catch (error) {
    return dualFailure(error);
  }

  const summon = (
    lens: "completeness" | "correctness",
  ): Promise<PublicSummonResult> => {
    // Single-axis public entry as-is: caller's argv + only --lens, under the
    // same cwd the omitted-lens call used. Durable projectRoot admits from
    // that argv/cwd pair; host turn runs on the ticket worktree (#997).
    return summonPublicRole({
      role: "reviewer",
      argv: withReviewerLens(options.argv, lens),
      cwd: options.cwd,
      // Ordinary single-axis public semantics — not a nested court station.
      stationChild: false,
      home: options.home,
      ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.engineModel === undefined ? {} : { engineModel: options.engineModel }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
      ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
      ...(options.principalAuthority === undefined
        ? {}
        : { principalAuthority: options.principalAuthority }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  };
  const settled = await Promise.allSettled([
    summon("completeness"),
    summon("correctness"),
  ]);
  return {
    completeness: settled[0].status === "fulfilled"
      ? settled[0].value
      : failedResult(settled[0].reason),
    correctness: settled[1].status === "fulfilled"
      ? settled[1].value
      : failedResult(settled[1].reason),
  };
}

/**
 * Gate officer summons. Argv / parentRunPath assembly is sole-sourced from
 * packagedGateSummon(officer) — not restated seat-by-seat here.
 */
export async function summonGateOfficer(options: {
  readonly officer: "inspector" | "notary" | "auditor" | "countersign";
  readonly sourceRunDirectory: string;
  readonly cwd: string;
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: CliIo;
  /** Parent cancellation for the nested officer activation (#675). */
  readonly signal?: AbortSignal;
  /**
   * Plain-language re-ask when the prior officer reply was not three-state (#753 / #756).
   * Officers: reviewReask → same-ticket resume summons.instruction.
   * Never concatenated into argv (binding stays on --source-run / parentRunPath).
   */
  readonly reask?: string;
  /**
   * In-flight parent 交卷 body (tool-call arguments). Relayed verbatim as officer
   * dialogue content when reask is absent (#879). Binding pointer stays on
   * --source-run / parentRunPath — never a content substitute.
   */
  readonly submission?: unknown;
  /** Pi-adapter inject — forwarded to summonPublicRole (not a parent-host override). */
  readonly roleTurnHost?: RoleTurnHost;
  readonly hostAdapters?: readonly NamedRoleTurnHostAdapter[];
  /** Offline test inject — forwarded to summonPublicRole. */
  readonly createRunId?: () => string;
}): Promise<PublicSummonResult> {
  let home = options.home;
  if (home === undefined) {
    const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
    // Hard path resolve: fail loud — never fall through to packageMachineHome (#604 / #675).
    home = homeFromRunDirectory(options.sourceRunDirectory);
  }
  // Officer host is seat-owned only (#821), not a parent override channel.
  // #879: binding pointer = parent run directory; dialogue content = submission body.
  // Conclusion re-ask keeps sole ownership of reviewReask when present.
  // #1208: notary never preloads parent body — fixed dispatch comes from
  // resolveReviewSeatDialogueBody for every source. Other officers still receive
  // the parent submission body.
  let gateReviewInstruction: string | undefined;
  if (
    options.reask === undefined
    && options.submission !== undefined
    && options.officer !== "notary"
  ) {
    const { readableGateItem } = await import("./readable-gate-item.ts");
    gateReviewInstruction = readableGateItem(options.submission);
  }
  const { runIdFromRunDirectory } = await import("./run-terminal-artifacts.ts");
  const parentRunId = runIdFromRunDirectory(options.sourceRunDirectory);
  const common = {
    cwd: options.cwd,
    ...(home === undefined ? {} : { home }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.io === undefined ? {} : { io: options.io }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.reask === undefined ? {} : { reviewReask: options.reask }),
    ...(gateReviewInstruction === undefined
      ? {}
      : { gateReviewInstruction }),
    ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
    ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(parentRunId === undefined || parentRunId.trim() === ""
      ? {}
      : { correlationId: parentRunId }),
  } as const;
  const { packagedGateSummon } = await import("./packaged-role-registry.ts");
  const gateSummon = packagedGateSummon(options.officer);
  if (gateSummon === "source-run") {
    // #753/#879: reask or verbatim body rides summons.instruction / first-mint prompt.
    // Binding stays --source-run (never folded into content).
    return summonPublicRole({
      role: options.officer,
      argv: ["--source-run", options.sourceRunDirectory, "--project", options.cwd],
      ...common,
    });
  }
  if (gateSummon === "subject-source") {
    // #756: judge compliance path — same queue law as notary/inspector.
    // Binding pointer on argv; dialogue content rides gateReviewInstruction.
    // #1166: no code-authored 卷宗指针 instruction — identity is startup material.
    return summonPublicRole({
      role: options.officer,
      argv: [
        "--subject",
        "judge",
        "--source-run",
        options.sourceRunDirectory,
        "--project",
        options.cwd,
      ],
      ...common,
    });
  }
  if (gateSummon === "parent-instruction") {
    // #969 / #987: Secretariat submission gate → 给事中.
    // Dialogue / identity instruction = parent typed payload 原话 (ADR 0079) or reask;
    // no code-authored summons prose (#924). Gate resume key = parentRunPath
    // (sourceRunDirectory); board ticket handoff is bind-only, never a resume
    // lookup (#987 Result 7). Receipt ticketNumber stays payload content.
    // Gate resume key is the parent run directory. The board ticket only binds.
    if (parentRunId === undefined || parentRunId.trim() === "") {
      throw new Error(
        `countersign gate summon requires parent runId from sourceRunDirectory: ${options.sourceRunDirectory}`,
      );
    }
    const correlationId = parentRunId;
    const { isSafePositiveTicketNumber, readBoardTicketNumber } = await import("./run-ticket-number.ts");
    const parentTicket = await readBoardTicketNumber(options.sourceRunDirectory);
    const submittedTicket = isRecord(options.submission)
      ? (options.submission as { ticketNumber?: unknown }).ticketNumber
      : undefined;
    const courtTicket = isSafePositiveTicketNumber(submittedTicket) ? submittedTicket : parentTicket;
    // Argv instruction = reask or parent payload bytes only (never a fabricated line).
    const instruction = options.reask ?? gateReviewInstruction ?? "";
    return summonPublicRole({
      role: options.officer,
      argv: ["--project", options.cwd, "--", instruction],
      ...common,
      correlationId,
      parentRunPath: options.sourceRunDirectory,
      ...(courtTicket === undefined ? {} : { boundTicketNumber: courtTicket }),
    });
  }
  // Inspector: bind via --source-run (same face as notary); dialogue rides env.
  // #1166: no code-authored 卷宗指针 instruction — identity is startup material.
  return summonPublicRole({
    role: options.officer,
    argv: ["--source-run", options.sourceRunDirectory, "--project", options.cwd],
    ...common,
  });
}
