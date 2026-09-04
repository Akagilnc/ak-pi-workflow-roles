/**
 * Registry-owned public command renderer (ADR 0052 / #106).
 * Typed role/phase facts → public `ak-role` command text.
 * Model-authored command prose is never executable output.
 *
 * Low-level shared owner: Navigator attendance and the public CLI both import
 * this module so dist/navigator-attendance.js keeps a complete dependency closure
 * without duplicating renderer logic into the preparation graph or bin bundle.
 */
import {
  PACKAGED_ROLE_REGISTRY,
  packagedRoleMetadata,
  type PackagedRole,
} from "./packaged-role-registry.ts";

export type PublicCommandPhase = "plan" | "apply" | null;

export type PublicCommandTarget = {
  role: string;
  phase: PublicCommandPhase;
};

const PUBLIC_CALLABLE_ROLES = new Set<string>(
  PACKAGED_ROLE_REGISTRY.map((entry) => entry.role),
);

export function isPublicCallableRole(role: string): role is PackagedRole {
  return PUBLIC_CALLABLE_ROLES.has(role);
}

/**
 * Render one public ak-role invocation from typed next-role facts.
 * Returns undefined when the role is not callable or role/phase cannot supply
 * all required admission values for a truthful command.
 */
export function renderPublicAkRoleCommand(
  target: PublicCommandTarget,
): string | undefined {
  if (!isPublicCallableRole(target.role)) return undefined;
  const role = target.role as PackagedRole;
  const metadata = packagedRoleMetadata(role);
  // A role whose admission requires typed values outside role/phase has no
  // truthful bare command. Navigator may still recommend the typed direction.
  if (metadata !== undefined && "bareCommand" in metadata && metadata.bareCommand === false) {
    return undefined;
  }
  if (target.phase === null || target.phase === undefined) {
    return `ak-role ${role}`;
  }
  // Coder/Fixer expose plan|apply; other roles have no public phase selector.
  if (role === "coder" || role === "fixer") {
    return `ak-role ${role} ${target.phase}`;
  }
  return `ak-role ${role}`;
}
