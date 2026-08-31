/**
 * Production composition for the grok-build RoleTurnHost adapter (#580 / #522).
 * Owns injectables around the S6 true adapter; does not alter S6 adapter behavior.
 *
 * Isolation contract: subprocess GROK_HOME, Fixer seatbelt hang root, and auth
 * copy share one ephemeral directory outside the retained run ledger. The grok
 * binary still resolves from the operator home. Callers pass that isolated home
 * into S6 as request.home (bash-seatbelt.ts: "callers must pass the isolated home").
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCanonicalSkillBinding as loadHomeCanonicalSkillBinding } from "../canonical-skill-binding.ts";
import { createGhCollectorGitHubTransport, createGhIssueSoftFetcher } from "../collector-github.ts";
import { loadDoctorCase } from "../doctor-evidence.ts";
import type { DurablePrincipalAuthority, RoleTurnHost, RoleTurnRequest } from "../host-contracts.ts";
import { createProductionMergerGitState } from "../merger-git-state.ts";
import { loadNotarySourceRunLocator } from "../notary-source-run.ts";
import { loadPackagedCanonicalSkillBinding } from "../package-resources/method-skill-binding.ts";
import type { RoleRuntimeDependencies } from "../role-runtime.ts";
import { createReviewerPinnedGitReader } from "../reviewer-pinned-git.ts";
import { loadMainRoleSessionMaterials } from "../session-opening-materials.ts";
import { createComposedGrokRoleTurnHost } from "./role-envelope.ts";
import {
  connectGrokAcpStdio,
  controlledGrokChildEnv,
  inspectControlledGrok,
  prepareControlledGrokHome,
  type GrokCapabilityDeclaration,
} from "./role-turn-host.ts";
import { createGrokSessionIdentityAuthority } from "./session-identity.ts";

/**
 * Authoritative production isolation binding consumed by inspect/connect and by
 * the S6 request.home rewrite (controlledHome).
 */
export type ProductionGrokIsolationBinding = Readonly<{
  operatorHome: string;
  controlledHome: string;
  binary: string;
  env: NodeJS.ProcessEnv;
}>;

export type ProductionGrokHostOptions = Readonly<{
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}>;

function resolveGrokBinary(operatorHome: string): string {
  return join(operatorHome, ".grok", "bin", "grok");
}

/**
 * Sole cleanup settlement for production controlled homes (auth-bearing temp roots).
 * Cleanup failure is never silenced. When a primary failure is present and cleanup
 * also fails, both surface as AggregateError; cleanup success rethrows primary.
 */
export async function settleProductionGrokHomeCleanup(
  controlledHome: string,
  primaryFailure: unknown,
  concurrentMessage: string,
): Promise<void> {
  try {
    await rm(controlledHome, { recursive: true, force: true });
  } catch (cleanupFailure) {
    if (primaryFailure !== undefined) {
      throw new AggregateError([primaryFailure, cleanupFailure], concurrentMessage, {
        cause: primaryFailure,
      });
    }
    throw cleanupFailure;
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure;
  }
}

/**
 * Open the production isolation root: auth copy only, never under runDirectory.
 * If auth copy fails after the temp root is created, the root is removed; open
 * failure and cleanup failure both surface (AggregateError when concurrent).
 */
export async function openProductionGrokHome(operatorHome: string): Promise<string> {
  const controlledHome = await mkdtemp(join(tmpdir(), "ak-grok-home-"));
  try {
    await prepareControlledGrokHome(operatorHome, controlledHome);
    return controlledHome;
  } catch (error) {
    await settleProductionGrokHomeCleanup(
      controlledHome,
      error,
      "production grok home open failed and its cleanup also failed",
    );
    // settle always throws when primaryFailure is set.
    throw error;
  }
}

function childEnv(controlledHome: string, packageRoot: string): NodeJS.ProcessEnv {
  return {
    ...controlledGrokChildEnv(process.env, controlledHome),
    AK_PACKAGE_ROOT: packageRoot,
  };
}

/**
 * Single production isolation binding: auth root, GROK_HOME/HOME, and binary
 * resolution. Production executeTurn passes controlledHome as S6 request.home
 * (seatbelt hang root proven separately by S6 seatbelt tests).
 */
export async function bindProductionGrokIsolation(
  operatorHome: string,
  packageRoot: string,
): Promise<ProductionGrokIsolationBinding> {
  const controlledHome = await openProductionGrokHome(operatorHome);
  return {
    operatorHome,
    controlledHome,
    binary: resolveGrokBinary(operatorHome),
    env: childEnv(controlledHome, packageRoot),
  };
}

/**
 * Bind isolation, run the turn body, always attempt controlledHome cleanup via
 * settleProductionGrokHomeCleanup (no silent catch). Success, typed-result, and
 * throw paths all clean up; cleanup failure and primary+cleanup both surface.
 */
export async function withProductionGrokIsolation<T>(
  operatorHome: string,
  packageRoot: string,
  run: (binding: ProductionGrokIsolationBinding) => Promise<T>,
): Promise<T> {
  let binding: ProductionGrokIsolationBinding | undefined;
  let primaryFailure: unknown;
  let value!: T;
  let succeeded = false;
  try {
    binding = await bindProductionGrokIsolation(operatorHome, packageRoot);
    value = await run(binding);
    succeeded = true;
  } catch (error) {
    primaryFailure = error;
  }

  if (binding !== undefined) {
    // No catch: settle throws cleanup failure or AggregateError with primary.
    await settleProductionGrokHomeCleanup(
      binding.controlledHome,
      primaryFailure,
      "production grok isolation turn and cleanup failed",
    );
  }

  if (primaryFailure !== undefined) throw primaryFailure;
  if (!succeeded) {
    throw new Error("production grok isolation ended without result");
  }
  return value;
}

/** Host-neutral packaged role runtime deps for the Grok parent-process envelope. */
export function createGrokRoleRuntimeDependencies(packageRoot: string): RoleRuntimeDependencies {
  return {
    loadJudgeSoul: () => loadMainRoleSessionMaterials("judge"),
    loadFixerSoul: () => loadMainRoleSessionMaterials("fixer"),
    loadFixPacket: (path) => readFile(path, "utf8"),
    loadCoderSoul: () => loadMainRoleSessionMaterials("coder"),
    loadCoderTask: (path) => readFile(path, "utf8"),
    loadReviewerSoul: () => loadMainRoleSessionMaterials("reviewer"),
    createReviewerPinnedGitReader: () => createReviewerPinnedGitReader(),
    createReviewerIssueFetcher: () => createGhIssueSoftFetcher(),
    loadCollectorSoul: () => loadMainRoleSessionMaterials("collector"),
    createCollectorTransport: () => createGhCollectorGitHubTransport(),
    loadDoctorSoul: () => loadMainRoleSessionMaterials("doctor"),
    loadDoctorCase,
    loadNotarySoul: () => loadMainRoleSessionMaterials("notary"),
    loadCountersignSoul: () => loadMainRoleSessionMaterials("countersign"),
    loadNotarySourceRun: loadNotarySourceRunLocator,
    loadMergerSoul: () => loadMainRoleSessionMaterials("merger"),
    loadMergerInput: async (path) => JSON.parse(await readFile(path, "utf8")),
    createMergerGitState: (repositoryRoot) => createProductionMergerGitState(repositoryRoot),
    async loadCanonicalSkillBinding(name) {
      if (name === "tdd") {
        return loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
      }
      if (name === "code-review") {
        return loadPackagedCanonicalSkillBinding(packageRoot, "code-review");
      }
      return loadHomeCanonicalSkillBinding(name);
    },
    // Pi-session auditors / navigator / reviewer-agent remain on the Pi host path.
    // Live grok-build completion of those branches is #511.
    async auditSoulCompliance() {
      throw new Error("grok-build host-neutral soul audit is not wired");
    },
    async auditDoctorCompliance() {
      throw new Error("grok-build host-neutral doctor audit is not wired");
    },
  };
}

async function recordGrokCapabilities(
  request: RoleTurnRequest,
  declaration: GrokCapabilityDeclaration,
): Promise<void> {
  await writeFile(
    join(request.runDirectory, "grok-capabilities.json"),
    `${JSON.stringify(declaration)}\n`,
    "utf8",
  );
}

/**
 * Assemble the production grok-build RoleTurnHost from the S6 true adapter.
 * Model×host rejection at selection time is owned by the named adapter create wrapper.
 */
export function createProductionGrokRoleTurnHost(options: ProductionGrokHostOptions): RoleTurnHost {
  const { packageRoot, principalAuthority } = options;
  // Single-slot turn isolation; outer serial keeps operator/controlled pairing intact.
  let turn: ProductionGrokIsolationBinding | undefined;
  let serial = Promise.resolve();

  const inner = createComposedGrokRoleTurnHost({
    sessionIdentity: createGrokSessionIdentityAuthority(principalAuthority),
    roleRuntimeDependencies: createGrokRoleRuntimeDependencies(packageRoot),
    recordCapabilities: recordGrokCapabilities,
    async inspect(request) {
      if (turn === undefined) {
        throw new Error("production grok inspect requires an active isolated turn");
      }
      return inspectControlledGrok({
        binary: turn.binary,
        cwd: request.cwd,
        env: turn.env,
        packageRoot,
      });
    },
    async connect(request) {
      if (turn === undefined) {
        throw new Error("production grok connect requires an active isolated turn");
      }
      return connectGrokAcpStdio({
        binary: turn.binary,
        cwd: request.cwd,
        env: turn.env,
        ...(request.model === undefined ? {} : { model: request.model.model }),
      });
    },
  });

  return {
    executeTurn(request) {
      const execution = serial.then(() =>
        withProductionGrokIsolation(request.home, packageRoot, async (binding) => {
          turn = binding;
          try {
            // S6 seatbelt hangs on request.home — same isolated root as GROK_HOME.
            return await inner.executeTurn({ ...request, home: binding.controlledHome });
          } finally {
            turn = undefined;
          }
        }),
      );
      serial = execution.then(
        () => undefined,
        () => undefined,
      );
      return execution;
    },
  };
}
