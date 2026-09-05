/**
 * Role-inside-role summons via the single public activation path (#675).
 * Gate / compliance / evidence callers invoke the same post-admission face a
 * human uses; no second institutional session open, no model-only seat page.
 *
 * Does not import public-cli/cli.ts (circular with role-runtime composition).
 * Composes the same seat resolution + role runners the CLI uses.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  homeFromRunDirectory,
  packageMachineHome,
  tryHomeFromAkRolesPath,
} from "./activation-ledger-topology.ts";
import { engineNameFromEnv } from "./engine-detour.ts";
import { piDurablePrincipalAuthority } from "./pi/durable-principal.ts";
import {
  appendPiSessionCustomEntry,
  createPiRoleTurnHost,
} from "./pi/role-turn-host.ts";
import type { CliIo } from "./public-cli/cli-io.ts";
import {
  loadCredentialProviders,
  loadPublicCliConfig,
  resolveEffectiveSeat,
  type CredentialProviders,
  type EffectiveSeat,
} from "./public-cli/config.ts";
import { runPublicInstructionSeat } from "./public-cli/instruction-seat-run.ts";
import { runPublicInspector } from "./public-cli/inspector-run.ts";
import {
  parseAuditorArgv,
  parseEvidenceChildArgv,
  parseGatekeeperArgv,
  parseInspectorArgv,
  parseNavigatorArgv,
  parseNotaryArgv,
  recordLaunchedPiIdentity,
  recordLaunchedRolePackageIdentity,
  observeLaunchedRolePackageIdentity,
} from "./public-cli/invocation.ts";
import { runPublicNotary } from "./public-cli/notary-run.ts";
import type { PublicCallableRole } from "./public-cli/registry.ts";
import type { TerminalResult } from "./public-cli/terminal.ts";

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

/** Install package root from this module (src/ or dist/). */
export function resolveSummonsPackageRoot(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "souls"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fileURLToPath(new URL("..", moduleUrl));
}

function resolveSummonHome(options: PublicSummonRequest): string {
  if (options.home !== undefined && options.home.trim() !== "") {
    return options.home;
  }
  const fromCwd = tryHomeFromAkRolesPath(options.cwd);
  if (fromCwd !== undefined && fromCwd.length > 0) return fromCwd;
  return packageMachineHome();
}

function projectSeatEngine(seat: EffectiveSeat): { engine?: string } {
  // Nested summons inherit the parent process engine when the child seat has none
  // (#378 dual-path / #675 public activation — same detour tool surface).
  const engine = seat.engine ?? engineNameFromEnv();
  return engine === undefined ? {} : { engine };
}

function projectSeatHost(seat: EffectiveSeat): { host?: string } {
  return seat.host === undefined ? {} : { host: seat.host };
}

function createSummonEnv(options: {
  readonly role: PublicCallableRole;
  readonly home: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly packageRoot: string;
  readonly credentials: CredentialProviders;
  readonly seat: EffectiveSeat;
}) {
  const principalAuthority = piDurablePrincipalAuthority;
  // Offline tracers may publish nested-spawn Pi args (faux provider -e path) via env.
  // Offline tracers may publish nested-spawn Pi args as JSON string array.
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
  return {
    home: options.home,
    principalAuthority,
    agentDir: options.agentDir,
    sessionAppender: appendPiSessionCustomEntry,
    packageRoot: options.packageRoot,
    roleTurnHost: createPiRoleTurnHost({
      packageRoot: options.packageRoot,
      principalAuthority,
      ...(nestedExtraPiArgs === undefined ? {} : { extraPiArgs: nestedExtraPiArgs }),
      recordLaunchedPiIdentity,
      recordLaunchedRolePackageIdentity,
      observeLaunchedRolePackageIdentity,
    }),
    cwd: options.cwd,
    credentials: options.credentials,
    ...(options.seat.selection === undefined ? {} : { model: options.seat.selection }),
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
  const packageRoot = options.packageRoot ?? resolveSummonsPackageRoot();
  const home = resolveSummonHome(options);
  const agentDir =
    options.agentDir
    ?? process.env.PI_CODING_AGENT_DIR
    ?? join(home, ".pi", "agent");
  const credentials =
    options.credentials ?? (await loadCredentialProviders(agentDir));
  const config = await loadPublicCliConfig(home);
  const seat = resolveEffectiveSeat(config, options.role, credentials);
  const env = createSummonEnv({
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
    case "notary":
      result = await runPublicNotary(options.argv, env, io, parseNotaryArgv);
      break;
    case "inspector":
      result = await runPublicInspector(options.argv, env, io, parseInspectorArgv);
      break;
    case "auditor":
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "auditor",
        parseAuditorArgv,
      );
      break;
    case "evidence-child":
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "evidence-child",
        parseEvidenceChildArgv,
      );
      break;
    case "navigator":
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "navigator",
        parseNavigatorArgv,
      );
      break;
    case "gatekeeper":
      result = await runPublicInstructionSeat(
        options.argv,
        env,
        io,
        "gatekeeper",
        parseGatekeeperArgv,
      );
      break;
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
  // Parent run topology owns home; project cwd is not under .ak-roles.
  let home = options.home;
  if (home === undefined) {
    try {
      home = homeFromRunDirectory(options.sourceRunDirectory);
    } catch {
      // Fall through to summonPublicRole home resolution.
    }
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
