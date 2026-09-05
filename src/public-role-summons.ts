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
import type { TerminalResult } from "./public-cli/terminal.ts";

/** Env published by the parent activation so nested summons never re-derive root. */
export const AK_ROLE_PACKAGE_ROOT_ENV = "AK_ROLE_PACKAGE_ROOT" as const;

export type PublicSummonRole =
  | "inspector"
  | "notary"
  | "auditor"
  | "evidence-child"
  | "navigator"
  | "gatekeeper";

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
};

export type PublicSummonResult = {
  readonly exitCode: number;
  readonly terminal?: TerminalResult;
  /** Offline diagnostics from nested CLI (structural rejection text). */
  readonly stderr?: string;
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

function projectSeatEngine(seat: EffectiveSeat): { engine?: string } {
  const raw = process.env.AK_ROLE_ENGINE;
  const fromEnv =
    typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  const engine = seat.engine ?? fromEnv;
  return engine === undefined ? {} : { engine };
}

function projectSeatHost(seat: EffectiveSeat): { host?: string } {
  return seat.host === undefined ? {} : { host: seat.host };
}

/** Nested seats with empty startup candidates inherit the live parent model (#675). */
async function projectSeatModel(
  seat: EffectiveSeat,
): Promise<{ model?: import("./public-cli/config.ts").SeatModelConfig }> {
  if (seat.selection !== undefined) return { model: seat.selection };
  const raw = process.env.AK_ROLE_NESTED_MODEL;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  const { parseModelSpec } = await import("./public-cli/config.ts");
  try {
    return { model: parseModelSpec(raw) };
  } catch {
    return {};
  }
}

async function createSummonEnv(options: {
  readonly role: PublicCallableRole;
  readonly home: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly packageRoot: string;
  readonly credentials: CredentialProviders;
  readonly seat: EffectiveSeat;
}) {
  const [{ piDurablePrincipalAuthority }, { appendPiSessionCustomEntry, createPiRoleTurnHost }] =
    await Promise.all([
      import("./pi/durable-principal.ts"),
      import("./pi/role-turn-host.ts"),
    ]);
  const principalAuthority = piDurablePrincipalAuthority;
  const nestedExtraRaw = process.env.AK_ROLE_NESTED_EXTRA_PI_ARGS;
  let nestedExtraPiArgs: readonly string[] | undefined;
  if (typeof nestedExtraRaw === "string" && nestedExtraRaw.trim() !== "") {
    try {
      const parsed = JSON.parse(nestedExtraRaw) as unknown;
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
        nestedExtraPiArgs = parsed;
      }
    } catch {
      // ignore malformed offline env
    }
  }
  process.env[AK_ROLE_PACKAGE_ROOT_ENV] = options.packageRoot;
  const piRecords = {
    async recordLaunchedPiIdentity(runDirectory: string, identity: unknown) {
      const { recordLaunchedPiIdentity } = await import("./public-cli/invocation.ts");
      return recordLaunchedPiIdentity(runDirectory, identity as never);
    },
    async recordLaunchedRolePackageIdentity(runDirectory: string, identity: unknown) {
      const { recordLaunchedRolePackageIdentity } = await import("./public-cli/invocation.ts");
      return recordLaunchedRolePackageIdentity(runDirectory, identity as never);
    },
    async observeLaunchedRolePackageIdentity(root: string, roleEntry: string) {
      const { observeLaunchedRolePackageIdentity } = await import("./public-cli/invocation.ts");
      return observeLaunchedRolePackageIdentity(root, roleEntry);
    },
  } as const;
  const piHost = createPiRoleTurnHost({
    packageRoot: options.packageRoot,
    principalAuthority,
    ...(nestedExtraPiArgs === undefined ? {} : { extraPiArgs: nestedExtraPiArgs }),
    ...piRecords,
  });
  // Same host axis table as public CLI (#617 DK-3 / #675): seat.host selects the adapter.
  const hostName = options.seat.host ?? "pi";
  let roleTurnHost = piHost;
  if (hostName === "grok-build") {
    const { loadProductionGrokHostFactory } = await import("./public-cli/load-production-grok-host.ts");
    let hostPromise: Promise<typeof piHost> | undefined;
    roleTurnHost = {
      executeTurn: async (request) => {
        hostPromise ??= loadProductionGrokHostFactory(options.packageRoot).then((create) =>
          create({
            packageRoot: options.packageRoot,
            principalAuthority,
          }),
        );
        return (await hostPromise).executeTurn(request);
      },
    };
  } else if (hostName !== "pi") {
    throw new Error(
      `public role summons host unregistered: host=${hostName} seat=${options.role}`,
    );
  }
  return {
    home: options.home,
    principalAuthority,
    agentDir: options.agentDir,
    sessionAppender: appendPiSessionCustomEntry,
    packageRoot: options.packageRoot,
    roleTurnHost,
    cwd: options.cwd,
    credentials: options.credentials,
    ...(await projectSeatModel(options.seat)),
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
  const seat = resolveEffectiveSeat(config, options.role, credentials);
  const env = await createSummonEnv({
    role: options.role,
    home,
    agentDir,
    cwd: options.cwd,
    packageRoot,
    credentials,
    seat,
  });
  const captured = options.io === undefined ? createCapturingIo() : undefined;
  const io = options.io ?? captured!.io;

  let result: { exitCode: number; terminal?: TerminalResult };
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
    case "evidence-child": {
      const [{ runPublicInstructionSeat }, { parseEvidenceChildArgv }] = await Promise.all([
        import("./public-cli/instruction-seat-run.ts"),
        import("./public-cli/invocation.ts"),
      ]);
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "evidence-child",
        parseEvidenceChildArgv,
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
  }

  const stderr = captured?.stderrText();
  return {
    exitCode: result.exitCode,
    ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
    ...(stderr === undefined || stderr === "" ? {} : { stderr }),
  };
}

/** Gate officer summons: notary via --source-run; inspector via pointer instruction. */
export async function summonGateOfficer(options: {
  readonly officer: "inspector" | "notary";
  readonly sourceRunDirectory: string;
  readonly cwd: string;
  readonly home?: string;
  readonly packageRoot?: string;
  readonly io?: CliIo;
}): Promise<PublicSummonResult> {
  let home = options.home;
  if (home === undefined) {
    const { homeFromRunDirectory } = await import("./activation-ledger-topology.ts");
    // Hard path resolve: fail loud — never fall through to packageMachineHome (#604 / #675).
    home = homeFromRunDirectory(options.sourceRunDirectory);
  }
  if (options.officer === "notary") {
    return summonPublicRole({
      role: "notary",
      argv: ["--source-run", options.sourceRunDirectory, "--project", options.cwd],
      cwd: options.cwd,
      ...(home === undefined ? {} : { home }),
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      ...(options.io === undefined ? {} : { io: options.io }),
    });
  }
  return summonPublicRole({
    role: "inspector",
    argv: [`卷宗指针：${options.sourceRunDirectory}`],
    cwd: options.cwd,
    ...(home === undefined ? {} : { home }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    ...(options.io === undefined ? {} : { io: options.io }),
  });
}
