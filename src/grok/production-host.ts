/**
 * Production composition for the grok-build RoleTurnHost adapter (#580 / #522).
 * Owns injectables around the S6 true adapter; does not alter S6 adapter behavior.
 */
import { readFile, writeFile } from "node:fs/promises";
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

export type ProductionGrokHostOptions = Readonly<{
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}>;

function resolveGrokBinary(operatorHome: string): string {
  return join(operatorHome, ".grok", "bin", "grok");
}

function controlledHomePath(request: RoleTurnRequest): string {
  return join(request.runDirectory, "grok-home");
}

async function ensureControlledHome(request: RoleTurnRequest): Promise<string> {
  const controlledHome = controlledHomePath(request);
  await prepareControlledGrokHome(request.home, controlledHome);
  return controlledHome;
}

function childEnv(controlledHome: string, packageRoot: string): NodeJS.ProcessEnv {
  return {
    ...controlledGrokChildEnv(process.env, controlledHome),
    AK_PACKAGE_ROOT: packageRoot,
  };
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
  return createComposedGrokRoleTurnHost({
    sessionIdentity: createGrokSessionIdentityAuthority(principalAuthority),
    roleRuntimeDependencies: createGrokRoleRuntimeDependencies(packageRoot),
    recordCapabilities: recordGrokCapabilities,
    async inspect(request) {
      const controlledHome = await ensureControlledHome(request);
      return inspectControlledGrok({
        binary: resolveGrokBinary(request.home),
        cwd: request.cwd,
        env: childEnv(controlledHome, packageRoot),
        packageRoot,
      });
    },
    async connect(request) {
      const controlledHome = await ensureControlledHome(request);
      return connectGrokAcpStdio({
        binary: resolveGrokBinary(request.home),
        cwd: request.cwd,
        env: childEnv(controlledHome, packageRoot),
        ...(request.model === undefined ? {} : { model: request.model.model }),
      });
    },
  });
}
