/** #922 host-native packaged method delivery. */
import { join } from "node:path";
import type { MethodBinding } from "./host-contracts.ts";

export const packagedMethodPluginDir = (root: string) => join(root, "dist", "method-host-plugin");

export function hasHostMethodSkill(methods: readonly MethodBinding[]): boolean {
  return methods.some((method) => method.kind === "skill");
}
