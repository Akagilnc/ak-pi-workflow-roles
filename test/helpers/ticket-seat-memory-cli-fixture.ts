/**
 * Shared public-CLI ticket-seat memory fixtures (#636 / #637).
 * Temp roots only under os.tmpdir; never delete directories; never write real home.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { PostAdmissionEnv } from "../../src/public-cli/post-admission.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import {
  installGhFixture,
  installHermesFixture,
} from "./hermes-fixture.ts";
import {
  packageRoot,
  seedGitRepository,
} from "./pi-test-harness.ts";

export { packageRoot };

/** Git project with github.com origin so diarist/seat bind can resolve. */
export function seedTicketSeatGitProject(root: string): void {
  seedGitRepository(root);
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
    { cwd: root },
  );
}

/**
 * Temp home under os.tmpdir only. Restores PATH; never deletes directories
 * (imperial #637 law / judge r1).
 */
export async function withTicketSeatMemoryHome(
  prefix: string,
  run: (ctx: { home: string; project: string; binDir: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const project = join(home, "project");
  const binDir = join(home, "bin");
  await mkdir(project, { recursive: true });
  seedTicketSeatGitProject(project);
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${prevPath ? `:${prevPath}` : ""}`;
  try {
    await run({ home, project, binDir });
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
}

export async function installSeatTicketFixtures(
  binDir: string,
  ticketNumber: number,
  options: { collectorSelections?: unknown[] } = {},
): Promise<void> {
  await installHermesFixture(binDir, {
    resolverResponse: { assertion: "ticket", ticketNumber },
    collectorResponse: { selections: options.collectorSelections ?? [] },
  });
  await installGhFixture(binDir, {
    issues: {
      [ticketNumber]: {
        body: `issue ${ticketNumber} body`,
        comments: [],
      },
    },
  });
}

export type PrincipalTurnObservation = {
  sessionFile: string;
  kind: RoleTurnRequest["continuation"]["kind"];
  runDirectory: string;
};

export type NativeHomeTurnObservation = {
  kind: RoleTurnRequest["continuation"]["kind"];
  runDirectory: string;
  nativeHomeRunDirectory?: string;
  previousHost?: string;
};

/** Host recorder for principal path + continuation kind + run directory. */
export function createPrincipalTurnRecorder(options?: {
  code?: number;
  stderr?: string;
}): {
  seen: PrincipalTurnObservation[];
  host: { executeTurn(request: RoleTurnRequest): Promise<{ code: number; stderr: string; timedOut: false }> };
} {
  const seen: PrincipalTurnObservation[] = [];
  return {
    seen,
    host: {
      async executeTurn(request: RoleTurnRequest) {
        const sessionFile = piDurablePrincipalAuthority.decode(
          request.principal,
        ).sessionFile;
        seen.push({
          sessionFile,
          kind: request.continuation.kind,
          runDirectory: request.runDirectory,
        });
        return {
          code: options?.code ?? 0,
          stderr: options?.stderr ?? "",
          timedOut: false as const,
        };
      },
    },
  };
}

/** Host recorder for native-home / host-transition wire facts. */
export function createNativeHomeTurnRecorder(options?: {
  code?: number;
  stderr?: string;
}): {
  seen: NativeHomeTurnObservation[];
  host: { executeTurn(request: RoleTurnRequest): Promise<{ code: number; stderr: string; timedOut: false }> };
} {
  const seen: NativeHomeTurnObservation[] = [];
  return {
    seen,
    host: {
      async executeTurn(request: RoleTurnRequest) {
        seen.push({
          kind: request.continuation.kind,
          runDirectory: request.runDirectory,
          ...(request.nativeHomeRunDirectory === undefined
            ? {}
            : { nativeHomeRunDirectory: request.nativeHomeRunDirectory }),
          ...(request.hostTransition === undefined
            ? {}
            : { previousHost: request.hostTransition.previousHost }),
        });
        return {
          code: options?.code ?? 1,
          stderr: options?.stderr ?? "controlled-stop\n",
          timedOut: false as const,
        };
      },
    },
  };
}

export function silentCliIo(): {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
} {
  return {
    stdout: (_t: string) => {},
    stderr: (_t: string) => {},
  };
}

/** Shared post-admission env axes for ticket-seat memory public entry tests. */
export function ticketSeatMemoryEnvBase(input: {
  home: string;
  project: string;
  host: { executeTurn(request: RoleTurnRequest): Promise<{ code: number; stderr: string; timedOut: boolean }> };
  liveHost?: string;
}): PostAdmissionEnv {
  return {
    packageRoot,
    home: input.home,
    agentDir: join(input.home, "agent"),
    cwd: input.project,
    principalAuthority: piDurablePrincipalAuthority,
    roleTurnHost: input.host,
    sessionAppender: appendPiSessionCustomEntry,
    ...(input.liveHost === undefined ? {} : { host: input.liveHost }),
  };
}

/**
 * Public entry settled a terminal for this call's own run (票面：各自独立终局).
 * Resume branch asserts only resume.command — never fill expectedRunId as the
 * actual terminal identity (恒真比较 banned by judge r1).
 */
export async function assertIndependentTerminal(input: {
  readonly label: string;
  readonly result: {
    readonly admitted?: { readonly runDirectory: string; readonly runId: string };
    readonly terminal?: TerminalResult;
  };
  readonly expectedRunId: string;
}): Promise<string> {
  assert.ok(
    input.result.terminal,
    `${input.label} must settle a terminal result`,
  );
  assert.ok(
    input.result.admitted,
    `${input.label} must retain its admitted run`,
  );
  assert.equal(input.result.admitted!.runId, input.expectedRunId);
  // Terminal is a discriminated face: runId XOR resume. Only assert the present arm.
  if (input.result.terminal!.runId !== undefined) {
    assert.equal(
      input.result.terminal!.runId,
      input.expectedRunId,
      `${input.label} terminal.runId must name this call's runId`,
    );
  }
  if (input.result.terminal!.resume !== undefined) {
    assert.ok(
      input.result.terminal!.resume.command.includes(input.expectedRunId),
      `${input.label} resume.command must name this call's runId`,
    );
  }
  const state = await readRoleRunState(
    input.result.admitted!.runDirectory,
    piDurablePrincipalAuthority,
  );
  assert.equal(
    state?.state,
    "terminal",
    `${input.label} run-state must be terminal`,
  );
  assert.equal(state?.runId, input.expectedRunId);
  return input.result.admitted!.runDirectory;
}
