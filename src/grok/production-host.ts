/**
 * Production composition for the grok-build RoleTurnHost adapter (#580 / #522 / #717).
 * Owns injectables around the S6 true adapter; does not alter S6 adapter behavior.
 *
 * Grok CLI uses the operator home (`~/.grok`) and credentials in place. The
 * factory does not create a run-scoped grok home, does not rewrite HOME, and
 * does not copy or scrub auth.json. Sititian records on the run are the dossier.
 */
import { readFile, writeFile } from "node:fs/promises";
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
  connectGrokAcpStdio,
  controlledGrokChildEnv,
  inspectControlledGrok,
  type GrokCapabilityDeclaration,
} from "./role-turn-host.ts";
import { createGrokSessionIdentityAuthority } from "./session-identity.ts";

export type ProductionGrokHostOptions = Readonly<{
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}>;

function resolveGrokBinary(operatorHome: string): string {
  return join(operatorHome, ".grok", "bin", "grok");
}

function childEnv(packageRoot: string): NodeJS.ProcessEnv {
  return {
    ...controlledGrokChildEnv(process.env),
    AK_PACKAGE_ROOT: packageRoot,
  };
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
 * Grok subprocesses inherit the operator home; the run directory is sitian-only.
 */
export function createProductionGrokRoleTurnHost(options: ProductionGrokHostOptions): RoleTurnHost {
  const { packageRoot, principalAuthority } = options;
  const env = childEnv(packageRoot);

  return createComposedGrokRoleTurnHost({
    sessionIdentity: createGrokSessionIdentityAuthority(principalAuthority),
    roleRuntimeDependencies: createGrokRoleRuntimeDependencies(packageRoot),
    recordCapabilities: recordGrokCapabilities,
    async inspect(request) {
      return inspectControlledGrok({
        binary: resolveGrokBinary(request.home),
        cwd: request.cwd,
        env,
        packageRoot,
      });
    },
    async connect(request) {
      return connectGrokAcpStdio({
        binary: resolveGrokBinary(request.home),
        cwd: request.cwd,
        env,
        ...(request.model === undefined ? {} : { model: request.model.model }),
      });
    },
  });
}
