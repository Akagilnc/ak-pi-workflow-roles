import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCanonicalSkillBinding as loadHomeCanonicalSkillBinding } from "./canonical-skill-binding.ts";
import { createGhCollectorGitHubTransport, createGhIssueSoftFetcher } from "./collector-github.ts";
import { createPiDoctorAuditor } from "./doctor-auditor.ts";
import { loadDoctorCase } from "./doctor-evidence.ts";
import { createNativeNavigatorSessionFactory, createNavigatorAttendance } from "./navigator-attendance.ts";
import { loadNavigatorWorkContext } from "./navigator-work-context.ts";
import { loadNotarySourceRunLocator } from "./notary-source-run.ts";
import { loadPackagedCanonicalSkillBinding } from "./package-resources/method-skill-binding.ts";
import { formatNavigatorRoleHelp, type RoleRuntimeDependencies } from "./role-runtime.ts";
import { createReviewerPinnedGitReader } from "./reviewer-pinned-git.ts";
import { loadAuditorSoulFromSubjectInput } from "./auditor-soul.ts";
import { loadGatekeeperSessionMaterials, loadMainRoleSessionMaterials } from "./session-opening-materials.ts";

const navigatorRoutePlaybookPath = fileURLToPath(
  new URL("../resources/navigator-route-playbook.md", import.meta.url),
);
const collectorHandbookSeedPath = fileURLToPath(
  new URL("../resources/collector-bot-handbook.md", import.meta.url),
);

/** Host-neutral packaged role runtime deps for the parent-process envelope. */
export function createRoleRuntimeDependencies(packageRoot: string): RoleRuntimeDependencies {
  const doctorAuditor = createPiDoctorAuditor();
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
    loadCollectorHandbookSeed: () => readFile(collectorHandbookSeedPath, "utf8"),
    createCollectorTransport: () => createGhCollectorGitHubTransport(),
    loadDoctorSoul: () => loadMainRoleSessionMaterials("doctor"),
    loadDoctorCase,
    loadInspectorSoul: () => loadMainRoleSessionMaterials("inspector"),
    loadGatekeeperSoul: () => loadGatekeeperSessionMaterials("gatekeeper"),
    loadNavigatorSoul: () => loadMainRoleSessionMaterials("navigator"),
    loadAuditorSoul: () => loadAuditorSoulFromSubjectInput(),
    loadNotarySoul: () => loadMainRoleSessionMaterials("notary"),
    loadCountersignSoul: () => loadMainRoleSessionMaterials("countersign"),
    loadGleanerLeftSoul: () => loadMainRoleSessionMaterials("gleaner-left"),
    loadDiaristSoul: () => loadMainRoleSessionMaterials("diarist"),
    loadNotarySourceRun: loadNotarySourceRunLocator,
    loadMergerSoul: () => loadMainRoleSessionMaterials("merger"),
    loadMergerInput: async (path) => JSON.parse(await readFile(path, "utf8")),
    async loadCanonicalSkillBinding(name) {
      if (name === "tdd") {
        return loadPackagedCanonicalSkillBinding(packageRoot, "tdd");
      }
      if (name === "code-review") {
        return loadPackagedCanonicalSkillBinding(packageRoot, "code-review");
      }
      return loadHomeCanonicalSkillBinding(name);
    },
    // #590: doctor compliance still on disposeCompliance path; judge→auditor is gate queue (#756).
    auditDoctorCompliance: (options) => doctorAuditor(options),
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
