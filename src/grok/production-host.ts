/**
 * grok-build host description plus the deferred factory the public CLI loader
 * imports (#732). Everything grok-specific in the ACP adapter lives here as
 * data; the lifecycle is the generic host in src/acp-host.
 */
import type { AcpHostDescription } from "../acp-host/description.ts";
import { createProductionAcpRoleTurnHost } from "../acp-host/production-host.ts";
import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";

export type ProductionGrokHostOptions = Readonly<{
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}>;

/** Grok CLI reads vendor-private compat surfaces unless each is disabled by name. */
const PRIVATE_COMPAT_ENV = Object.fromEntries(
  ["CLAUDE", "CURSOR", "CODEX"].flatMap((vendor) =>
    ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"].map((kind) =>
      [`GROK_${vendor}_${kind}_ENABLED`, "false"] as const)),
);

/** The grok-build ACP host: operator home `~/.grok`, native session/load resume. */
export const GROK_BUILD_HOST_DESCRIPTION: AcpHostDescription = Object.freeze({
  binaryFromHome: [".grok", "bin", "grok"],
  argv: Object.freeze({
    prefix: ["agent"],
    suffix: ["stdio"],
    modelFlag: "--model",
    thinkingFlag: "--reasoning-effort",
  }),
  boundResume: "session/load",
  sessionBindingFile: "grok-acp-session.json",
  childEnv: Object.freeze({
    ...PRIVATE_COMPAT_ENV,
    GROK_MEMORY: "0",
    GROK_SUBAGENTS: "0",
  }),
});

/** Assemble the production grok-build RoleTurnHost from the generic ACP host. */
export function createProductionGrokRoleTurnHost(options: ProductionGrokHostOptions): RoleTurnHost {
  return createProductionAcpRoleTurnHost({
    packageRoot: options.packageRoot,
    principalAuthority: options.principalAuthority,
    description: GROK_BUILD_HOST_DESCRIPTION,
  });
}
