/**
 * Production composition for the grok-build RoleTurnHost adapter (#580 / #522 / #594).
 * Owns injectables around the S6 true adapter; does not alter S6 adapter behavior.
 *
 * Isolation contract: subprocess GROK_HOME, Fixer seatbelt hang root, and auth
 * copy share one directory under the runDirectory ledger (grok-home). The grok
 * binary still resolves from the operator home. Callers pass that isolated home
 * into S6 as request.home (bash-seatbelt.ts: "callers must pass the isolated home").
 * Auth is copied from the operator home into grok-home for the turn and scrubbed
 * on settle together with AK seatbelt hook residue; the session dossier directly
 * written under grok-home survives settlement (ADR 0048 / ADR 0077 / #594).
 *
 * Known residual risk: a hard process crash between auth copy and settle can leave
 * auth.json in the retained run ledger for one crash window. The next open scrubs
 * residual auth before recopying; single-crash-window residue is accepted.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCanonicalSkillBinding as loadHomeCanonicalSkillBinding } from "../canonical-skill-binding.ts";
import { createGhCollectorGitHubTransport, createGhIssueSoftFetcher } from "../collector-github.ts";
import { createPiDoctorAuditor } from "../doctor-auditor.ts";
import { loadDoctorCase } from "../doctor-evidence.ts";
import type { DurablePrincipalAuthority, RoleTurnHost, RoleTurnRequest } from "../host-contracts.ts";
import { createPiJudgeAuditor } from "../judge-auditor.ts";
import { createProductionMergerGitState } from "../merger-git-state.ts";
import { createNativeNavigatorSessionFactory, createNavigatorAttendance } from "../navigator-attendance.ts";
import { loadNavigatorWorkContext } from "../navigator-work-context.ts";
import { loadNotarySourceRunLocator } from "../notary-source-run.ts";
import { loadPackagedCanonicalSkillBinding } from "../package-resources/method-skill-binding.ts";
import { createPerDispatchReviewerAgent } from "../reviewer-agent.ts";
import { formatNavigatorRoleHelp, type RoleRuntimeDependencies } from "../role-runtime.ts";
import { createReviewerPinnedGitReader } from "../reviewer-pinned-git.ts";
import { loadGatekeeperSessionMaterials, loadMainRoleSessionMaterials } from "../session-opening-materials.ts";
import { createComposedGrokRoleTurnHost } from "./role-envelope.ts";
import {
  assertControlledGrokAuthIsNotSymlink,
  assertControlledGrokHomeIsRealDirectory,
  connectGrokAcpStdio,
  controlledGrokChildEnv,
  inspectControlledGrok,
  prepareControlledGrokHome,
  scrubAkBashSeatbeltHooks,
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
 * Primary-failure state for cleanup settlement. `undefined` is a legal primary
 * value (throw/reject undefined), so presence is an explicit discriminant — never
 * inferred from `value !== undefined`.
 */
export type ProductionGrokPrimaryFailure =
  | Readonly<{ present: false }>
  | Readonly<{ present: true; value: unknown }>;

export const NO_PRODUCTION_GROK_PRIMARY_FAILURE = {
  present: false,
} as const satisfies ProductionGrokPrimaryFailure;

/**
 * Sole cleanup settlement for production controlled homes: scrub auth secrets
 * (auth.json) and AK seatbelt hook residue while preserving the session dossier
 * under the runDirectory ledger. Refuses symlink home/auth so rm never follows a
 * redirect (#594 F1/F4). Cleanup failure is never silenced. When a primary failure
 * is present and cleanup also fails, both surface as AggregateError (including
 * primary value `undefined`); cleanup success rethrows the primary value as-is.
 */
export async function settleProductionGrokHomeCleanup(
  controlledHome: string,
  primaryFailure: ProductionGrokPrimaryFailure,
  concurrentMessage: string,
): Promise<void> {
  try {
    await assertControlledGrokHomeIsRealDirectory(controlledHome);
    const authPath = join(controlledHome, "auth.json");
    await assertControlledGrokAuthIsNotSymlink(authPath);
    await rm(authPath, { force: true });
    await scrubAkBashSeatbeltHooks(controlledHome);
  } catch (cleanupFailure) {
    if (primaryFailure.present) {
      throw new AggregateError([primaryFailure.value, cleanupFailure], concurrentMessage, {
        cause: primaryFailure.value,
      });
    }
    throw cleanupFailure;
  }
  if (primaryFailure.present) {
    throw primaryFailure.value;
  }
}

/**
 * Open the production isolation root under runDirectory: auth copy into grok-home.
 * If auth copy fails after the root is created, auth secrets are scrubbed; open
 * failure and cleanup failure both surface (AggregateError when concurrent).
 */
export async function openProductionGrokHome(
  runDirectory: string,
  operatorHome: string,
): Promise<string> {
  const controlledHome = join(runDirectory, "grok-home");
  try {
    await prepareControlledGrokHome(operatorHome, controlledHome);
    return controlledHome;
  } catch (error) {
    await settleProductionGrokHomeCleanup(
      controlledHome,
      { present: true, value: error },
      "production grok home open failed and its cleanup also failed",
    );
    // settle always throws when primaryFailure is present.
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
  runDirectory: string,
  operatorHome: string,
  packageRoot: string,
): Promise<ProductionGrokIsolationBinding> {
  const controlledHome = await openProductionGrokHome(runDirectory, operatorHome);
  return {
    operatorHome,
    controlledHome,
    binary: resolveGrokBinary(operatorHome),
    env: childEnv(controlledHome, packageRoot),
  };
}

/**
 * Bind isolation under runDirectory, run the turn body, always scrub auth.json
 * and AK seatbelt hooks via settleProductionGrokHomeCleanup (no silent catch)
 * while preserving the session dossier under runDirectory/grok-home. Success,
 * typed-result, and throw paths all clean up; cleanup failure and primary+cleanup
 * both surface. Same-run Grok isolation only — no cross-run home override (#637).
 */
export async function withProductionGrokIsolation<T>(
  runDirectory: string,
  operatorHome: string,
  packageRoot: string,
  run: (binding: ProductionGrokIsolationBinding) => Promise<T>,
): Promise<T> {
  let binding: ProductionGrokIsolationBinding | undefined;
  let primaryFailure: ProductionGrokPrimaryFailure = NO_PRODUCTION_GROK_PRIMARY_FAILURE;
  let value!: T;
  try {
    binding = await bindProductionGrokIsolation(runDirectory, operatorHome, packageRoot);
    value = await run(binding);
  } catch (error) {
    primaryFailure = { present: true, value: error };
  }

  if (binding !== undefined) {
    // No catch: settle throws cleanup failure or AggregateError with primary.
    await settleProductionGrokHomeCleanup(
      binding.controlledHome,
      primaryFailure,
      "production grok isolation turn and cleanup failed",
    );
  }

  if (primaryFailure.present) throw primaryFailure.value;
  return value;
}

const navigatorRoutePlaybookPath = fileURLToPath(
  new URL("../../resources/navigator-route-playbook.md", import.meta.url),
);

/** Host-neutral packaged role runtime deps for the Grok parent-process envelope. */
export function createGrokRoleRuntimeDependencies(packageRoot: string): RoleRuntimeDependencies {
  const judgeAuditor = createPiJudgeAuditor();
  const doctorAuditor = createPiDoctorAuditor();
  const reviewerAgent = createPerDispatchReviewerAgent({ packageRoot });
  const navigatorSessionFactory = createNativeNavigatorSessionFactory();
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
    loadInspectorSoul: () => loadMainRoleSessionMaterials("inspector"),
    loadGatekeeperSoul: () => loadGatekeeperSessionMaterials("gatekeeper"),
    loadNavigatorSoul: () => loadMainRoleSessionMaterials("navigator"),
    loadNotarySoul: () => loadMainRoleSessionMaterials("notary"),
    loadCountersignSoul: () => loadMainRoleSessionMaterials("countersign"),
    loadGleanerLeftSoul: () => loadMainRoleSessionMaterials("gleaner-left"),
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
    // #590: four sub-legs on the shared institutional child seam (host-neutral).
    auditSoulCompliance: (options) => judgeAuditor(options),
    auditDoctorCompliance: (options) => doctorAuditor(options),
    runReviewerDispatch: (dispatch, options) => reviewerAgent.run(dispatch, options),
    shutdownReviewerAgent: () => reviewerAgent.shutdown(),
    loadNavigatorWorkContext: (options) => loadNavigatorWorkContext({
      context: options.context,
      role: options.role,
      ...(options.getFlag === undefined ? {} : { getFlag: options.getFlag }),
    }),
    createNavigatorAttendance: (options) => createNavigatorAttendance({
      context: options.context,
      role: options.role,
      phase: options.phase,
      subjectKey: options.subjectKey,
      subject: options.subject,
      authority: options.authority,
      invocationId: options.invocationId,
      loadSoul: () => loadMainRoleSessionMaterials("navigator"),
      loadRoutePlaybook: () => readFile(navigatorRoutePlaybookPath, "utf8"),
      loadRoleHelp: async (role) => formatNavigatorRoleHelp(role),
      createSession: navigatorSessionFactory,
      ...(options.contextError === undefined ? {} : { contextError: options.contextError }),
      onEvent: options.onEvent,
    }),
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
 * Isolation always under the live request.runDirectory (same-run resume keeps it).
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
        withProductionGrokIsolation(
          request.runDirectory,
          request.home,
          packageRoot,
          async (binding) => {
            turn = binding;
            try {
              // S6 seatbelt hangs on request.home — same isolated root as GROK_HOME.
              return await inner.executeTurn({ ...request, home: binding.controlledHome });
            } finally {
              turn = undefined;
            }
          },
        ),
      );
      serial = execution.then(
        () => undefined,
        () => undefined,
      );
      return execution;
    },
  };
}
