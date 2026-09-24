import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createGhCollectorGitHubTransport } from "./collector-github.ts";
import { createPiDoctorAuditor } from "./doctor-auditor.ts";
import { loadDoctorCase } from "./doctor-evidence.ts";
import { createNativeNavigatorSessionFactory, createNavigatorAttendance } from "./navigator-attendance.ts";
import { loadNavigatorWorkContext } from "./navigator-work-context.ts";
import { loadNotarySourceRunLocator } from "./notary-source-run.ts";
import { loadPackagedCanonicalSkillBinding } from "./package-resources/method-skill-binding.ts";
import { type RoleRuntimeDependencies } from "./role-runtime.ts";
import {
  loadAuditorReferenceMaterialsFromSubjectInput,
  loadAuditorSoulFromSubjectInput,
} from "./auditor-soul.ts";
import { packagedRoleMetadata, type PackagedRole } from "./packaged-role-registry.ts";
import {
  loadMainRoleReferenceMaterials,
  loadMainRoleSessionMaterials,
} from "./session-opening-materials.ts";

function usesSubjectSoul(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined && "soulSource" in record && record.soulSource === "subject";
}

/** Single packaged source for reference materials across production composition roots. */
export function loadPackagedRoleReferenceMaterials(role: Parameters<NonNullable<RoleRuntimeDependencies["loadRoleReferenceMaterials"]>>[0]): Promise<string> {
  return usesSubjectSoul(role)
    ? loadAuditorReferenceMaterialsFromSubjectInput()
    : loadMainRoleReferenceMaterials(role);
}

/** One production soul loader. Subject seats read the subject input; every other seat reads its record. */
export function loadRegisteredRoleSoul(role: PackagedRole): Promise<string> {
  return usesSubjectSoul(role)
    ? loadAuditorSoulFromSubjectInput()
    : loadMainRoleSessionMaterials(role);
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
    loadRoleSoul: loadRegisteredRoleSoul,
    loadFixPacket: (path) => readFile(path, "utf8"),
    loadCoderTask: (path) => readFile(path, "utf8"),
    loadCollectorHandbookSeed: () => readFile(collectorHandbookSeedPath, "utf8"),
    createCollectorTransport: () => createGhCollectorGitHubTransport(),
    loadDoctorCase,
    loadNotarySourceRun: loadNotarySourceRunLocator,
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
      loadRoutePlaybook: () => readFile(navigatorRoutePlaybookPath, "utf8"),
      createSession: navigatorSessionFactory,
      ...(options.contextError === undefined ? {} : { contextError: options.contextError }),
      onEvent: options.onEvent,
    }),
  };
}
