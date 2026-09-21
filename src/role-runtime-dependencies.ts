import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createGhCollectorGitHubTransport } from "./collector-github.ts";
import { createPiDoctorAuditor } from "./doctor-auditor.ts";
import { loadDoctorCase } from "./doctor-evidence.ts";
import { createNativeNavigatorSessionFactory, createNavigatorAttendance } from "./navigator-attendance.ts";
import { loadNavigatorWorkContext } from "./navigator-work-context.ts";
import { loadNotarySourceRunLocator } from "./notary-source-run.ts";
import { loadPackagedCanonicalSkillBinding } from "./package-resources/method-skill-binding.ts";
import { formatNavigatorRoleHelp, type RoleRuntimeDependencies } from "./role-runtime.ts";
import {
  loadAuditorReferenceMaterialsFromSubjectInput,
  loadAuditorSoulFromSubjectInput,
} from "./auditor-soul.ts";
import {
  loadGatekeeperSessionMaterials,
  loadMainRoleReferenceMaterials,
  loadMainRoleSessionMaterials,
} from "./session-opening-materials.ts";

/** Single packaged source for reference materials across production composition roots. */
export function loadPackagedRoleReferenceMaterials(role: Parameters<NonNullable<RoleRuntimeDependencies["loadRoleReferenceMaterials"]>>[0]): Promise<string> {
  return role === "auditor"
    ? loadAuditorReferenceMaterialsFromSubjectInput()
    : loadMainRoleReferenceMaterials(role);
}

/** Host-neutral packaged role runtime deps for the parent-process envelope. */
export function createRoleRuntimeDependencies(packageRoot: string): RoleRuntimeDependencies {
  // packageRoot is the install root (resources/ lives there). Never resolve via
  // import.meta.url — headless/acp production-host bundles live under dist/*/
  // and would otherwise look for dist/resources/ (#962).
  const navigatorRoutePlaybookPath = join(packageRoot, "resources/navigator-route-playbook.md");
  const collectorHandbookSeedPath = join(packageRoot, "resources/collector-bot-handbook.md");
  const doctorAuditor = createPiDoctorAuditor();
  const navigatorSessionFactory = createNativeNavigatorSessionFactory();
  return {
    packageRoot,
    loadRoleReferenceMaterials: loadPackagedRoleReferenceMaterials,
    loadJudgeSoul: () => loadMainRoleSessionMaterials("judge"),
    loadFixerSoul: () => loadMainRoleSessionMaterials("fixer"),
    loadFixPacket: (path) => readFile(path, "utf8"),
    loadCoderSoul: () => loadMainRoleSessionMaterials("coder"),
    loadCoderTask: (path) => readFile(path, "utf8"),
    loadReviewerSoul: () => loadMainRoleSessionMaterials("reviewer"),
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
    loadSecretariatSoul: () => loadMainRoleSessionMaterials("secretariat"),
    loadNotarySourceRun: loadNotarySourceRunLocator,
    loadMergerSoul: () => loadMainRoleSessionMaterials("merger"),
    loadMergerInput: async (path) => JSON.parse(await readFile(path, "utf8")),
    async loadCanonicalSkillBinding(name) {
      switch (name) {
        case "tdd":
          return loadPackagedCanonicalSkillBinding(packageRoot, name);
        case "ak-cross-m-review":
          return loadPackagedCanonicalSkillBinding(packageRoot, name);
        default: {
          const unexpected: never = name;
          throw new Error(`Canonical skill is not packaged: ${String(unexpected)}`);
        }
      }
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
