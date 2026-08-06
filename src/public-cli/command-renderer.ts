/**
 * Registry-owned public command renderer (ADR 0052 / #106).
 * Typed role/phase/subject facts → public `ak-role` command text.
 * Model-authored command prose is never executable output.
 */
import {
  isPublicCallableRole,
  type PublicCallableRole,
} from "./registry.ts";
import type { NavigatorPhase } from "../navigator-attendance.ts";

export type PublicCommandTarget = {
  role: string;
  phase: NavigatorPhase;
};

/**
 * Render one public ak-role invocation from typed next-role facts.
 * Returns undefined when the target is not a public callable role.
 */
export function renderPublicAkRoleCommand(
  target: PublicCommandTarget,
): string | undefined {
  if (!isPublicCallableRole(target.role)) return undefined;
  const role = target.role as PublicCallableRole;
  if (target.phase === null || target.phase === undefined) {
    return `ak-role ${role}`;
  }
  // Coder/Fixer expose plan|apply; other roles have no public phase selector.
  if (role === "coder" || role === "fixer") {
    return `ak-role ${role} ${target.phase}`;
  }
  return `ak-role ${role}`;
}
