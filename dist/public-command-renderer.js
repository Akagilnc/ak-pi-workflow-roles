import {
  PACKAGED_ROLE_REGISTRY
} from "./packaged-role-registry.js";
const PUBLIC_CALLABLE_ROLES = new Set(
  PACKAGED_ROLE_REGISTRY.map((entry) => entry.role)
);
function renderPublicAkRoleCommand(target) {
  if (!PUBLIC_CALLABLE_ROLES.has(target.role)) return void 0;
  const role = target.role;
  if (target.phase === null || target.phase === void 0) {
    return `ak-role ${role}`;
  }
  if (role === "coder" || role === "fixer") {
    return `ak-role ${role} ${target.phase}`;
  }
  return `ak-role ${role}`;
}
export {
  renderPublicAkRoleCommand
};
