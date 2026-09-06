/**
 * Production composition for the generic ACP RoleTurnHost adapter (#732).
 * Owns injectables around the S6 true adapter; does not alter adapter behavior.
 *
 * The agent runs against the operator home and its credentials in place. The
 * factory does not create a run-scoped agent home, does not rewrite HOME, and
 * does not copy or scrub credentials. Sitian records on the run are the dossier.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCanonicalSkillBinding as loadHomeCanonicalSkillBinding } from "../canonical-skill-binding.ts";
import { createGhCollectorGitHubTransport, createGhIssueSoftFetcher } from "../collector-github.ts";
import { createPiDoctorAuditor } from "../doctor-auditor.ts";
import { loadDoctorCase } from "../doctor-evidence.ts";
import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";
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
import { acpStdioArgs, resolveAcpBinary, type AcpHostDescription } from "./description.ts";
import { createComposedAcpRoleTurnHost } from "./role-envelope.ts";
import { connectAcpStdio } from "./role-turn-host.ts";
import { createAcpSessionIdentityAuthority } from "./session-identity.ts";

export type ProductionAcpHostOptions = Readonly<{
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
  description: AcpHostDescription;
}>;

const navigatorRoutePlaybookPath = fileURLToPath(
  new URL("../../resources/navigator-route-playbook.md", import.meta.url),
);

/** Host-neutral packaged role runtime deps for the ACP parent-process envelope. */
export function createAcpRoleRuntimeDependencies(packageRoot: string): RoleRuntimeDependencies {
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
    loadDiaristSoul: () => loadMainRoleSessionMaterials("diarist"),
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

/**
 * Assemble a production ACP RoleTurnHost from the S6 true adapter for one host
 * description. Agent subprocesses inherit the operator home; the run directory
 * is sitian-only.
 */
export function createProductionAcpRoleTurnHost(options: ProductionAcpHostOptions): RoleTurnHost {
  const { packageRoot, principalAuthority, description } = options;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...description.childEnv,
    AK_PACKAGE_ROOT: packageRoot,
  };

  return createComposedAcpRoleTurnHost({
    sessionIdentity: createAcpSessionIdentityAuthority(principalAuthority, description.sessionBindingFile),
    boundResume: description.boundResume,
    roleRuntimeDependencies: createAcpRoleRuntimeDependencies(packageRoot),
    async connect(request) {
      return connectAcpStdio({
        binary: resolveAcpBinary(description, request.home),
        args: acpStdioArgs(description, request.model),
        cwd: request.cwd,
        env,
      });
    },
  });
}
