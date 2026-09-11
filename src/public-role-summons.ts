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
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CliIo } from "./public-cli/cli-io.ts";
import type { CredentialProviders, EffectiveSeat } from "./public-cli/config.ts";
import type { PublicCallableRole } from "./public-cli/registry.ts";
import type { RoleTurnHost } from "./host-contracts.ts";
import type { HostSelectionFailure, NamedRoleTurnHostAdapter } from "./public-cli/role-turn-host-resolution.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";

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
  | "diarist";

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
  readonly agentDir?: string;
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
  /** Typed ticket number handoff for diarist child run (#840). */
  readonly boundTicketNumber?: number;
};

export type PublicSummonResult = {
  readonly exitCode: number;
  readonly terminal?: TerminalResult;
  /** Independent officer/role run directory (正本); parent books pointer only. */
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

/** Seat axes only — no parent-env fallback (#675 / #617 DK-3). */
function projectSeatEngine(seat: EffectiveSeat): { engine?: string } {
  return seat.engine === undefined ? {} : { engine: seat.engine };
}

function projectSeatHost(seat: EffectiveSeat): { host?: string } {
  return seat.host === undefined ? {} : { host: seat.host };
}

function hostSelectionFailureFromUnknown(error: unknown): HostSelectionFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ((error as { name?: unknown }).name !== "HostSelectionError") return undefined;
  const failure = (error as { failure?: HostSelectionFailure }).failure;
  return failure;
}

async function createSummonEnv(options: {
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
}) {
  const [{ piDurablePrincipalAuthority }, { appendPiSessionCustomEntry }, { resolveRoleTurnHost }] =
    await Promise.all([
      import("./pi/durable-principal.ts"),
      import("./pi/role-turn-host.ts"),
      import("./public-cli/role-turn-host-resolution.ts"),
    ]);
  const principalAuthority = piDurablePrincipalAuthority;
  // Same host axis table as public CLI (#617 DK-3 / #675 / #840): child seat
  // selects; injected roleTurnHost is the pi adapter only.
  const roleTurnHost = resolveRoleTurnHost(
    {
      packageRoot: options.packageRoot,
      ...(options.roleTurnHost === undefined ? {} : { roleTurnHost: options.roleTurnHost }),
      ...(options.hostAdapters === undefined ? {} : { hostAdapters: options.hostAdapters }),
      ...(options.extraPiArgs === undefined || options.extraPiArgs.length === 0
        ? {}
        : { extraPiArgs: options.extraPiArgs }),
    },
    { role: options.role, seat: options.seat, principalAuthority },
  );
  const hostName = options.seat.host ?? "pi";
  // #788: host is registered above; only then project host-facing provider.
  const { loadHostProvidersTable, projectHostFacingProvider } = await import(
    "./public-cli/host-providers.ts"
  );
  const hostFacingSelection =
    options.seat.selection === undefined
      ? undefined
      : projectHostFacingProvider(
          options.seat.selection,
          hostName,
          loadHostProvidersTable(options.home),
          options.home,
        );
  return {
    home: options.home,
    principalAuthority,
    agentDir: options.agentDir,
    sessionAppender: appendPiSessionCustomEntry,
    packageRoot: options.packageRoot,
    roleTurnHost,
    cwd: options.cwd,
    credentials: options.credentials,
    ...(hostFacingSelection === undefined ? {} : { model: hostFacingSelection }),
    ...projectSeatEngine(options.seat),
    ...projectSeatHost(options.seat),
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
  const agentDir =
    options.agentDir
    ?? process.env.PI_CODING_AGENT_DIR
    ?? join(home, ".pi", "agent");
  const {
    loadCredentialProviders,
    loadPublicCliConfig,
    resolveEffectiveSeat,
  } = await import("./public-cli/config.ts");
  const credentials =
    options.credentials ?? (await loadCredentialProviders(agentDir));
  const config = await loadPublicCliConfig(home);
  // Nested summons resolve host on the officer seat only (flag>seat>default pi).
  // Parent run host is not an override channel (#821 / ADR 0082 host-flag-two-channels).
  const seat = resolveEffectiveSeat(config, options.role, credentials);
  let summonEnv;
  try {
    summonEnv = await createSummonEnv({
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
    });
  } catch (error) {
    const failure = hostSelectionFailureFromUnknown(error);
    if (failure !== undefined) {
      const { formatHostSelectionFailure } = await import("./public-cli/role-turn-host-resolution.ts");
      return { exitCode: 1, stderr: formatHostSelectionFailure(failure) };
    }
    throw error;
  }
  const env = {
    ...summonEnv,
    // Station child role run (#840): omit automatic navigator attendance.
    stationChild: true,
    // Host config passthrough only — same face as public CLI (#422 / #675).
    ...(config.autoResumeLimit === undefined
      ? {}
      : { autoResumeLimit: config.autoResumeLimit }),
    // Parent cancellation reaches the nested activation's own turn dispatch.
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // #753: reask rides the existing notary same-ticket resume summons.instruction.
    ...(options.reviewReask === undefined ? {} : { reviewReask: options.reviewReask }),
    // #879: verbatim submission body on officer dialogue content channel.
    ...(options.gateReviewInstruction === undefined
      ? {}
      : { gateReviewInstruction: options.gateReviewInstruction }),
    ...(options.boundTicketNumber === undefined
      ? {}
      : { boundTicketNumber: options.boundTicketNumber }),
    // createRunId is the only remaining env overlay — host is seat-selected above.
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
  };
  const captured = options.io === undefined ? createCapturingIo() : undefined;
  const io = options.io ?? captured!.io;

  let result: {
    exitCode: number;
    terminal?: TerminalResult;
    admitted?: { readonly runDirectory?: string };
  };
  switch (options.role) {
    case "notary": {
      const [{ runPublicNotary }, { parseNotaryArgv }] = await Promise.all([
        import("./public-cli/notary-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicNotary(options.argv, env, io, parseNotaryArgv);
      break;
    }
    case "inspector": {
      const [{ runPublicInspector }, { parseInspectorArgv }] = await Promise.all([
        import("./public-cli/inspector-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicInspector(options.argv, env, io, parseInspectorArgv);
      break;
    }
    case "auditor": {
      const [{ runPublicInstructionSeat }, { parseAuditorArgv }] = await Promise.all([
        import("./public-cli/instruction-seat-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "auditor",
        parseAuditorArgv,
      );
      break;
    }
    case "navigator": {
      const [{ runPublicInstructionSeat }, { parseNavigatorArgv }] = await Promise.all([
        import("./public-cli/instruction-seat-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "navigator",
        parseNavigatorArgv,
      );
      break;
    }
    case "gatekeeper": {
      const [{ runPublicInstructionSeat }, { parseGatekeeperArgv }] = await Promise.all([
        import("./public-cli/instruction-seat-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "gatekeeper",
        parseGatekeeperArgv,
      );
      break;
    }
    case "judge": {
      const [{ runPublicJudge }, { parseJudgeArgv }] = await Promise.all([
        import("./public-cli/judge-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicJudge(options.argv, env, io, parseJudgeArgv);
      break;
    }
    case "doctor": {
      const [{ runPublicDoctor }, { parseDoctorArgv }] = await Promise.all([
        import("./public-cli/doctor-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicDoctor(options.argv, env, io, parseDoctorArgv);
      break;
    }
    case "diarist": {
      const [{ runPublicDiarist }, { parseDiaristArgv }] = await Promise.all([
        import("./public-cli/diarist-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicDiarist(options.argv, env, io, parseDiaristArgv);
      break;
    }
  }

  const stderr = captured?.stderrText();
  const runDirectory = result.admitted?.runDirectory;
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

/** Gate officer summons: notary/auditor via --source-run; inspector via pointer instruction. */
export async function summonGateOfficer(options: {
  readonly officer: "inspector" | "notary" | "auditor";
  readonly sourceRunDirectory: string;
  readonly cwd: string;
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: CliIo;
  /** Parent cancellation for the nested officer activation (#675). */
  readonly signal?: AbortSignal;
  /**
   * Plain-language re-ask when the prior officer reply was not three-state (#753 / #756).
   * All three officers: reviewReask → same-ticket resume summons.instruction.
   * Never concatenated into argv (inspector parentRunPath is the pure 卷宗指针).
   */
  readonly reask?: string;
  /**
   * In-flight parent 交卷 body (tool-call arguments). Relayed verbatim as officer
   * dialogue content when reask is absent (#879). Binding pointer stays on
   * --source-run / 卷宗指针 argv — never a content substitute.
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
  // Officer host is seat-owned only (#821). Parent invocation.json.host stays a
  // hostTransition consumer in post-admission — not an officer override channel.
  // #879: binding pointer = parent run directory; dialogue content = submission body.
  // Conclusion re-ask keeps sole ownership of reviewReask when present.
  let gateReviewInstruction: string | undefined;
  if (options.reask === undefined && options.submission !== undefined) {
    const { readableGateItem } = await import("./readable-gate-item.ts");
    gateReviewInstruction = readableGateItem(options.submission);
  }
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
  } as const;
  if (options.officer === "notary") {
    // #753/#879: reask or verbatim body rides summons.instruction / first-mint prompt.
    // Binding stays --source-run (never folded into content).
    return summonPublicRole({
      role: "notary",
      argv: ["--source-run", options.sourceRunDirectory, "--project", options.cwd],
      ...common,
    });
  }
  if (options.officer === "auditor") {
    // #756: judge compliance path — same queue law as notary/inspector.
    // Binding pointer on argv; dialogue content rides gateReviewInstruction.
    return summonPublicRole({
      role: "auditor",
      argv: [
        "--subject",
        "judge",
        "--source-run",
        options.sourceRunDirectory,
        `卷宗指针：${options.sourceRunDirectory}`,
      ],
      ...common,
    });
  }
  // Inspector: argv stays pure 卷宗指针 (#747 parentRunPath lookup key).
  // Content (body/reask) rides env → summons.instruction / first-mint prompt.
  return summonPublicRole({
    role: "inspector",
    argv: [`卷宗指针：${options.sourceRunDirectory}`],
    ...common,
  });
}
